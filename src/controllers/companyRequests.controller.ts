import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { PoolClient } from 'pg';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId, generateRandomToken } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { sendPlatformEmail } from '../utils/mailer';
import { getPublicServerUrl, recordUpload } from '../utils/uploadAccess';
import { notifyCitySubscribers } from './cities.controller';
import { createAdminAlert, resolveAdminAlerts } from '../utils/adminAlerts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REASON_LENGTH = 1000;
// Only inert image types get served back from our domain (no SVG or PDF)
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const uploadsDir = path.join(__dirname, '../../uploads');

const ACTIVE_STATUSES = ['pending', 'under_review', 'on_hold'];
const REVIEW_STATUSES = ['under_review', 'on_hold', 'approved', 'rejected'];

// Staff identity (reviewed_by) stays out of what the applicant receives
const APPLICANT_COLUMNS = 'id, status, status_reason, company_name, license_number, email, created_at, reviewed_at';

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

// Recording the upload is what lets the applicant open their own protected document later
const saveImage = async (req: Request, image: { buffer: Buffer; ext: string } | null, folder: string, userId: string): Promise<string | null> => {
  if (!image) return null;
  const dir = path.join(uploadsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${image.ext}`;
  fs.writeFileSync(path.join(dir, filename), image.buffer);
  await recordUpload(filename, folder, userId);
  return `${getPublicServerUrl(req)}/uploads/${folder}/${filename}`;
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const sendStatusEmail = async (to: string, companyName: string, status: string, reason: string | null) => {
  const name = escapeHtml(companyName);
  const reasonHtml = reason ? `<p><strong>السبب:</strong> ${escapeHtml(reason)}</p>` : '';
  const messages: Record<string, { subject: string; body: string }> = {
    approved: {
      subject: 'تم قبول طلب تسجيل شركتك - سدرة',
      body: `<p>تم قبول طلب تسجيل شركة <strong>${name}</strong>. افتح تطبيق سدرة للشركات لبدء إدارة شركتك.</p>`,
    },
    on_hold: {
      subject: 'طلب تسجيل شركتك يحتاج إلى استكمال - سدرة',
      body: `<p>يحتاج طلب تسجيل شركة <strong>${name}</strong> إلى استكمال.</p>${reasonHtml}<p>افتح تطبيق سدرة للشركات لرفع المستند المطلوب.</p>`,
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
      to,
      fallbackSubject: message.subject,
      fallbackHtml: `<div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 24px;">${message.body}</div>`,
    });
  } catch (err) {
    console.error('[Mailer] Error sending company request status email:', err);
  }
};

export const createCompanyRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // The owner always comes from the token, never from the request body
    const userId = String(req.user!.id);
    const { companyName, governorate, city, phone, email, address, licenseNumber, taxNumber, licenseDoc, logo } = req.body;

    const licenseImage = decodeImage(licenseDoc);
    const logoImage = decodeImage(logo);

    const userRes = await pool.query('SELECT is_verified FROM users WHERE id = $1', [userId]);
    if (userRes.rows[0]?.is_verified !== true) {
      res.status(403).json({ error: 'يرجى تفعيل حسابك برمز التحقق قبل تقديم طلب تسجيل شركة' });
      return;
    }

    const ownedCompany = await pool.query('SELECT 1 FROM companies WHERE user_id = $1 LIMIT 1', [userId]);
    if (ownedCompany.rows.length > 0) {
      res.status(409).json({ error: 'حسابك مرتبط بشركة بالفعل' });
      return;
    }

    const activeRequest = await pool.query(
      'SELECT 1 FROM company_requests WHERE user_id = $1 AND status = ANY($2)',
      [userId, ACTIVE_STATUSES]
    );
    if (activeRequest.rows.length > 0) {
      res.status(409).json({ error: 'لديك طلب قيد المراجعة بالفعل' });
      return;
    }

    const created = await pool.query(
      `INSERT INTO company_requests (
        id, user_id, company_name, governorate, city, phone, email, address, license_number, tax_number,
        license_doc_url, logo_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING ${APPLICANT_COLUMNS}`,
      [
        generate16CharId(), userId, companyName.trim(), governorate.trim(), city.trim(), phone.trim(),
        email.trim().toLowerCase(), address.trim(), licenseNumber.trim(), taxNumber?.trim() || null,
        await saveImage(req, licenseImage, 'documents', userId),
        await saveImage(req, logoImage, 'companies', userId),
      ]
    );

    await createAdminAlert({
      type: 'company_request',
      module: 'companies',
      title: 'طلب انضمام شركة جديد',
      body: `${companyName.trim()} · ${city.trim()}، ${governorate.trim()}`,
      entityType: 'company_request',
      entityId: created.rows[0].id,
      link: `/companies/requests?id=${created.rows[0].id}`,
      requiresAction: true,
    });

    res.status(201).json({ success: true, message: 'تم إرسال طلب تسجيل الشركة بنجاح', data: created.rows[0] });
  } catch (error: any) {
    if (error instanceof InvalidImageError) {
      res.status(400).json({ error: error.message });
      return;
    }
    // Two submissions raced past the check above and the partial unique index caught the second
    if (error.code === '23505') {
      res.status(409).json({ error: 'لديك طلب قيد المراجعة بالفعل' });
      return;
    }
    console.error('Error creating company request:', error);
    res.status(500).json({ error: 'فشل إرسال طلب تسجيل الشركة' });
  }
};

export const getMyCompanyRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT ${APPLICANT_COLUMNS} FROM company_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [String(req.user!.id)]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error: any) {
    console.error('Error fetching my company request:', error);
    res.status(500).json({ error: 'فشل جلب طلب تسجيل الشركة' });
  }
};

// The applicant's answer to "تعليق": a clearer document sends the request back to the review queue.
export const resubmitMyCompanyRequestDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.user!.id);
    const image = decodeImage(req.body.licenseDoc);

    const heldRequest = await pool.query(
      `SELECT id FROM company_requests WHERE user_id = $1 AND status = 'on_hold' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (heldRequest.rows.length === 0) {
      res.status(409).json({ error: 'لا يوجد طلب بانتظار استكمال المستندات' });
      return;
    }

    const updated = await pool.query(
      `UPDATE company_requests
       SET license_doc_url = $1, status = 'pending', status_reason = NULL, reviewed_by = NULL, reviewed_at = NULL
       WHERE id = $2 AND user_id = $3 AND status = 'on_hold'
       RETURNING ${APPLICANT_COLUMNS}`,
      [await saveImage(req, image, 'documents', userId), heldRequest.rows[0].id, userId]
    );
    if (updated.rows.length === 0) {
      res.status(409).json({ error: 'لا يوجد طلب بانتظار استكمال المستندات' });
      return;
    }

    await createAdminAlert({
      type: 'company_request',
      module: 'companies',
      title: 'طلب شركة عاد للمراجعة',
      body: `${updated.rows[0].company_name} رفعت المستند المطلوب`,
      entityType: 'company_request',
      entityId: updated.rows[0].id,
      link: `/companies/requests?id=${updated.rows[0].id}`,
      requiresAction: true,
      merge: true,
    });

    res.json({ success: true, message: 'تم رفع المستند وإعادة الطلب للمراجعة', data: updated.rows[0] });
  } catch (error: any) {
    if (error instanceof InvalidImageError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error resubmitting company request document:', error);
    res.status(500).json({ error: 'فشل رفع المستند' });
  }
};

const ADMIN_SELECT = `
  SELECT cr.id, cr.status, cr.status_reason, cr.company_name, cr.governorate, cr.city, cr.phone, cr.email, cr.address,
         cr.license_number, cr.tax_number, cr.license_doc_url, cr.logo_url, cr.company_id, cr.reviewed_by, cr.reviewed_at,
         cr.created_at, cr.user_id, u.name AS owner_name, u.email AS owner_email
  FROM company_requests cr
  LEFT JOIN users u ON cr.user_id = u.id`;

export const getCompanyRequests = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.query;
    const result = status
      ? await pool.query(`${ADMIN_SELECT} WHERE cr.status = $1 ORDER BY cr.created_at DESC`, [String(status)])
      : await pool.query(`${ADMIN_SELECT} ORDER BY cr.created_at DESC`);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching company requests:', error);
    res.status(500).json({ error: 'فشل جلب طلبات الشركات' });
  }
};

class ReviewConflictError extends Error {}

// Runs inside the review transaction, so a failure leaves no company behind.
const createCompanyFromRequest = async (client: PoolClient, request: any) => {
  if (!request.user_id) {
    throw new ReviewConflictError('هذا الطلب قديم وغير مرتبط بحساب، يرجى رفضه ليعيد صاحبه التقديم من حسابه');
  }
  const ownedCompany = await client.query('SELECT 1 FROM companies WHERE user_id = $1 LIMIT 1', [request.user_id]);
  if (ownedCompany.rows.length > 0) {
    throw new ReviewConflictError('صاحب هذا الطلب مرتبط بشركة أخرى بالفعل');
  }

  const governorateName = String(request.governorate).replace(/^محافظة\s+/, '').trim();
  const cityRes = await client.query('SELECT id FROM cities WHERE position($1 in name) > 0 LIMIT 1', [governorateName]);
  const cityId: string | null = cityRes.rows[0]?.id || null;

  const fullAddress = [request.address, request.city, request.governorate]
    .filter((part, index) => index === 0 || !request.address.includes(part))
    .join('، ');

  // The account keeps role 'user': 'owner' means platform owner here and would open the admin routes
  const companyId = generate16CharId();
  await client.query(
    `INSERT INTO companies (
      id, user_id, city_id, name, description, short_description, phone, contact_email, address, logo_url,
      commercial_register_url, license_number, tax_number, field_verified, verified, rating, reviews_count, public_id
    ) VALUES ($1, $2, $3, $4, '', '', $5, $6, $7, $8, $9, $10, $11, false, false, 0.0, 0, $12)`,
    [
      companyId, request.user_id, cityId, request.company_name, request.phone, request.email, fullAddress, request.logo_url,
      request.license_doc_url, request.license_number, request.tax_number, generateRandomToken('cmp'),
    ]
  );

  return { companyId, cityId };
};

export const updateCompanyRequestStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const { status } = req.body || {};
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() || null : null;

  if (!REVIEW_STATUSES.includes(status)) {
    res.status(400).json({ error: 'حالة الطلب غير صالحة' });
    return;
  }
  if (reason && reason.length > MAX_REASON_LENGTH) {
    res.status(400).json({ error: 'السبب طويل جدًا' });
    return;
  }

  const client = await pool.connect();
  let inTransaction = false;
  let released = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;

    const requestRes = await client.query('SELECT * FROM company_requests WHERE id = $1 FOR UPDATE', [String(req.params.id)]);
    const request = requestRes.rows[0];
    if (!request) throw new ReviewConflictError('الطلب غير موجود');
    if (!ACTIVE_STATUSES.includes(request.status)) {
      throw new ReviewConflictError('تم البت في هذا الطلب مسبقًا ولا يمكن تغيير حالته');
    }

    const approval = status === 'approved' ? await createCompanyFromRequest(client, request) : null;

    await client.query(
      `UPDATE company_requests
       SET status = $1, status_reason = $2, company_id = $3, reviewed_by = $4, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [status, status === 'on_hold' || status === 'rejected' ? reason : null, approval?.companyId || null, req.user?.email || null, request.id]
    );

    await client.query('COMMIT');
    inTransaction = false;
    client.release();
    released = true;

    if (approval?.cityId) {
      await pool.query('UPDATE cities SET total_companies = (SELECT COUNT(*) FROM companies WHERE city_id = $1) WHERE id = $1', [approval.cityId]);
      notifyCitySubscribers(approval.cityId, request.company_name).catch((err) => console.error('City notification error:', err));
    }

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'مراجعة طلب تسجيل شركة',
      `تم تغيير حالة طلب شركة "${request.company_name}" إلى: ${status}${reason ? ` - السبب: ${reason}` : ''}`,
      req.ip,
      req.user?.email || 'المسؤول'
    );

    // Approved, rejected or put on hold, the request has been dealt with; a resubmitted document raises a new alert
    await resolveAdminAlerts('company_request', request.id, req.user?.email || null);

    const updated = await pool.query(`${ADMIN_SELECT} WHERE cr.id = $1`, [request.id]);
    await sendStatusEmail(updated.rows[0].owner_email || request.email, request.company_name, status, reason);

    res.json({ success: true, message: 'تم تحديث حالة الطلب بنجاح', data: updated.rows[0] });
  } catch (error: any) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof ReviewConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error('Error updating company request status:', error);
    res.status(500).json({ error: 'فشل تحديث حالة الطلب' });
  } finally {
    if (!released) client.release();
  }
};
