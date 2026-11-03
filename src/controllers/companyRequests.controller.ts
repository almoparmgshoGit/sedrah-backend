import { Request, Response } from 'express';
import argon2 from 'argon2';
import fs from 'fs';
import path from 'path';
import { PoolClient } from 'pg';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId, generateRandomToken } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { sendPlatformEmail } from '../utils/mailer';
import { getPublicServerUrl } from '../utils/uploadAccess';
import { notifyCitySubscribers } from './cities.controller';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// The endpoint is public, so only inert image types get served back from our domain (no SVG or PDF)
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const uploadsDir = path.join(__dirname, '../../uploads');

const ACTIVE_STATUSES = ['pending', 'under_review', 'on_hold'];
const REVIEW_STATUSES = ['under_review', 'on_hold', 'approved', 'rejected'];

// Every column except password_hash, which must never reach the dashboard
const PUBLIC_COLUMNS = `id, status, status_reason, company_name, governorate, city, phone, email, address,
  license_number, tax_number, license_doc_url, logo_url, company_id, reviewed_by, reviewed_at, created_at`;

class InvalidImageError extends Error {}

const decodeImage = (dataUri?: string | null): { buffer: Buffer; ext: string } | null => {
  if (!dataUri) return null;
  const match = dataUri.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i);
  const ext = match && IMAGE_EXTENSIONS[match[1].toLowerCase()];
  if (!match || !ext) throw new InvalidImageError('يجب أن تكون الصور بصيغة JPG أو PNG أو WEBP');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new InvalidImageError('حجم الصورة يتجاوز الحد المسموح (5 ميجابايت)');
  return { buffer, ext };
};

const saveImage = (req: Request, image: { buffer: Buffer; ext: string } | null, folder: string): string | null => {
  if (!image) return null;
  const dir = path.join(uploadsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${image.ext}`;
  fs.writeFileSync(path.join(dir, filename), image.buffer);
  return `${getPublicServerUrl(req)}/uploads/${folder}/${filename}`;
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const sendStatusEmail = async (request: any, status: string, reason: string | null, linkedExistingAccount: boolean) => {
  const name = escapeHtml(request.company_name);
  const reasonHtml = reason ? `<p><strong>السبب:</strong> ${escapeHtml(reason)}</p>` : '';
  const messages: Record<string, { subject: string; body: string }> = {
    approved: {
      subject: 'تم قبول طلب تسجيل شركتك - سدرة',
      body: linkedExistingAccount
        ? `<p>تم قبول طلب تسجيل شركة <strong>${name}</strong>، وتم ربطها بحسابك الحالي في سدرة. سجّل الدخول في تطبيق سدرة للشركات ببيانات حسابك الحالي.</p>`
        : `<p>تم قبول طلب تسجيل شركة <strong>${name}</strong>. سجّل الدخول في تطبيق سدرة للشركات بالبريد وكلمة المرور اللذين أدخلتهما في الطلب، وسيصلك رمز تحقق لتفعيل حسابك عند أول دخول.</p>`,
    },
    on_hold: {
      subject: 'تم تعليق طلب تسجيل شركتك - سدرة',
      body: `<p>تم تعليق طلب تسجيل شركة <strong>${name}</strong> مؤقتًا.</p>${reasonHtml}`,
    },
    rejected: {
      subject: 'تم رفض طلب تسجيل شركتك - سدرة',
      body: `<p>نأسف لإبلاغك بأنه تم رفض طلب تسجيل شركة <strong>${name}</strong>.</p>${reasonHtml}<p>يمكنك تقديم طلب جديد من تطبيق سدرة للشركات.</p>`,
    },
  };

  const message = messages[status];
  if (!message) return;
  try {
    await sendPlatformEmail({
      to: request.email,
      fallbackSubject: message.subject,
      fallbackHtml: `<div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 24px;">${message.body}</div>`,
    });
  } catch (err) {
    console.error('[Mailer] Error sending company request status email:', err);
  }
};

export const createCompanyRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { companyName, governorate, city, phone, address, licenseNumber, taxNumber, password, licenseDoc, logo } = req.body;
    const email = req.body.email.trim().toLowerCase();

    const licenseImage = decodeImage(licenseDoc);
    const logoImage = decodeImage(logo);

    const existingUser = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'هذا البريد الإلكتروني مسجل بالفعل في سدرة، يرجى استخدام بريد آخر' });
      return;
    }

    const activeRequest = await pool.query(
      'SELECT 1 FROM company_requests WHERE LOWER(email) = $1 AND status = ANY($2)',
      [email, ACTIVE_STATUSES]
    );
    if (activeRequest.rows.length > 0) {
      res.status(409).json({ error: 'يوجد طلب قيد المراجعة بهذا البريد الإلكتروني' });
      return;
    }

    const passwordHash = await argon2.hash(password);
    const id = generate16CharId();
    await pool.query(
      `INSERT INTO company_requests (
        id, company_name, governorate, city, phone, email, address, license_number, tax_number,
        license_doc_url, logo_url, password_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id, companyName.trim(), governorate.trim(), city.trim(), phone.trim(), email, address.trim(),
        licenseNumber.trim(), taxNumber?.trim() || null,
        saveImage(req, licenseImage, 'documents'), saveImage(req, logoImage, 'companies'), passwordHash,
      ]
    );

    res.status(201).json({ success: true, message: 'تم إرسال طلب تسجيل الشركة بنجاح', data: { id } });
  } catch (error: any) {
    if (error instanceof InvalidImageError) {
      res.status(400).json({ error: error.message });
      return;
    }
    // Two submissions raced past the check above and the partial unique index caught the second
    if (error.code === '23505') {
      res.status(409).json({ error: 'يوجد طلب قيد المراجعة بهذا البريد الإلكتروني' });
      return;
    }
    console.error('Error creating company request:', error);
    res.status(500).json({ error: 'فشل إرسال طلب تسجيل الشركة' });
  }
};

export const getCompanyRequests = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.query;
    const result = status
      ? await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM company_requests WHERE status = $1 ORDER BY created_at DESC`, [String(status)])
      : await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM company_requests ORDER BY created_at DESC`);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching company requests:', error);
    res.status(500).json({ error: 'فشل جلب طلبات الشركات' });
  }
};

// Runs inside the review transaction, so a failure leaves neither a user nor a company behind.
const createCompanyFromRequest = async (client: PoolClient, request: any) => {
  const existingUser = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [request.email]);
  const linkedExistingAccount = existingUser.rows.length > 0;
  let userId: string;

  if (linkedExistingAccount) {
    // The address gained an account after the request was sent (customer app or Google).
    // That account's password stays: the one in this request never proved ownership of the email.
    userId = existingUser.rows[0].id;
  } else {
    // Role stays 'user': 'owner' means platform owner here and would open the admin routes.
    // is_verified = false is what makes the first login ask for the OTP.
    userId = generate16CharId();
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, phone, role, balance, is_verified)
       VALUES ($1, $2, $3, $4, $5, 'user', 0.00, false)`,
      [userId, request.company_name, request.email, request.password_hash, request.phone]
    );
  }

  const governorateName = String(request.governorate).replace(/^محافظة\s+/, '').trim();
  const cityRes = await client.query('SELECT id FROM cities WHERE position($1 in name) > 0 LIMIT 1', [governorateName]);
  const cityId: string | null = cityRes.rows[0]?.id || null;

  const fullAddress = [request.address, request.city, request.governorate]
    .filter((part, index) => index === 0 || !request.address.includes(part))
    .join('، ');

  const companyId = generate16CharId();
  await client.query(
    `INSERT INTO companies (
      id, user_id, city_id, name, description, short_description, phone, address, logo_url,
      commercial_register_url, license_number, tax_number, field_verified, verified, rating, reviews_count, public_id
    ) VALUES ($1, $2, $3, $4, '', '', $5, $6, $7, $8, $9, $10, false, false, 0.0, 0, $11)`,
    [
      companyId, userId, cityId, request.company_name, request.phone, fullAddress, request.logo_url,
      request.license_doc_url, request.license_number, request.tax_number, generateRandomToken('cmp'),
    ]
  );

  return { companyId, cityId, linkedExistingAccount };
};

export const updateCompanyRequestStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const { status } = req.body || {};
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() || null : null;

  if (!REVIEW_STATUSES.includes(status)) {
    res.status(400).json({ error: 'حالة الطلب غير صالحة' });
    return;
  }

  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');

    const requestRes = await client.query('SELECT * FROM company_requests WHERE id = $1 FOR UPDATE', [String(req.params.id)]);
    if (requestRes.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'الطلب غير موجود' });
      return;
    }

    const request = requestRes.rows[0];
    if (!ACTIVE_STATUSES.includes(request.status)) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'تم البت في هذا الطلب مسبقًا ولا يمكن تغيير حالته' });
      return;
    }

    const approval = status === 'approved' ? await createCompanyFromRequest(client, request) : null;

    const updated = await client.query(
      `UPDATE company_requests
       SET status = $1::varchar, status_reason = $2, company_id = $3, reviewed_by = $4, reviewed_at = CURRENT_TIMESTAMP,
           password_hash = CASE WHEN $1::varchar = 'approved' THEN NULL ELSE password_hash END
       WHERE id = $5
       RETURNING ${PUBLIC_COLUMNS}`,
      [status, status === 'on_hold' || status === 'rejected' ? reason : null, approval?.companyId || null, req.user?.email || null, request.id]
    );

    await client.query('COMMIT');
    client.release();
    released = true;

    if (approval?.cityId) {
      await pool.query('UPDATE cities SET total_companies = (SELECT COUNT(*) FROM companies WHERE city_id = $1) WHERE id = $1', [approval.cityId]);
      notifyCitySubscribers(approval.cityId, request.company_name).catch((err) => console.error('City notification error:', err));
    }

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'مراجعة طلب تسجيل شركة',
      `تم تغيير حالة طلب شركة "${request.company_name}" (${request.email}) إلى: ${status}${reason ? ` - السبب: ${reason}` : ''}`,
      req.ip,
      req.user?.email || 'المسؤول'
    );

    await sendStatusEmail(request, status, reason, !!approval?.linkedExistingAccount);

    res.json({
      success: true,
      message: 'تم تحديث حالة الطلب بنجاح',
      data: { ...updated.rows[0], linked_existing_account: !!approval?.linkedExistingAccount },
    });
  } catch (error: any) {
    if (!released) await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating company request status:', error);
    res.status(500).json({ error: 'فشل تحديث حالة الطلب' });
  } finally {
    if (!released) client.release();
  }
};

// Tells an applicant with the right password why they cannot sign in yet. Null keeps the normal "wrong credentials" answer.
export const getCompanyRequestLoginMessage = async (email: string, password: string): Promise<string | null> => {
  const result = await pool.query(
    'SELECT status, status_reason, password_hash FROM company_requests WHERE LOWER(email) = LOWER($1) ORDER BY created_at DESC LIMIT 1',
    [email]
  );
  const request = result.rows[0];
  if (!request?.password_hash || !(await argon2.verify(request.password_hash, password))) return null;

  const reason = request.status_reason ? ` السبب: ${request.status_reason}` : '';
  if (request.status === 'on_hold') return `طلب تسجيل شركتك معلّق حاليًا.${reason}`;
  if (request.status === 'rejected') return `تم رفض طلب تسجيل شركتك.${reason} يمكنك تقديم طلب جديد.`;
  if (ACTIVE_STATUSES.includes(request.status)) return 'طلب تسجيل شركتك قيد المراجعة، وسيمكنك الدخول بعد قبوله.';
  return null;
};
