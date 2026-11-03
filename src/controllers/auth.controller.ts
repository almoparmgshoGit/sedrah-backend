import { Request, Response } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import type { PoolClient } from 'pg';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { safeParseArray } from '../middlewares/permission.middleware';
import { formatUserId, generate16CharId } from '../utils/formatId';
import { sendPlatformEmail } from '../utils/mailer';
import { resolveUserUpload } from '../utils/uploadAccess';

export const issueTokenPair = async (
  user: { id: string; email: string; role: string; permissions?: string[] },
  clientType: 'customer' | 'company' | 'admin' = 'customer',
  userAgent?: string,
  ipAddress?: string
) => {
  const audMap: Record<string, string> = {
    customer: 'sdra-customer',
    company: 'sdra-company',
    admin: 'sdra-admin',
  };
  const aud = audMap[clientType] || 'sdra-customer';

  // Access token: 15 minutes
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role, permissions: user.permissions || [] },
    env.JWT_SECRET,
    { expiresIn: '15m', audience: aud, issuer: 'sdra-backend' }
  );

  // Refresh token: 30 days
  const rawRefreshToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
  const familyId = generate16CharId();
  const tokenId = generate16CharId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, client_type, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tokenId, user.id, tokenHash, familyId, clientType, expiresAt, userAgent || null, ipAddress || null]
  );

  return { accessToken, refreshToken: `${tokenId}.${rawRefreshToken}` };
};

export const generateGuestToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const guestToken = jwt.sign(
      { id: 'guest_' + generate16CharId(), role: 'guest' },
      env.JWT_SECRET,
      { expiresIn: '30m', audience: 'sdra-guest', issuer: 'sdra-backend' }
    );
    res.json({ success: true, guest_token: guestToken, token: guestToken, expires_in: 1800 });
  } catch (error: any) {
    console.error('Error generating guest token:', error);
    res.status(500).json({ error: 'فشل إصدار توكن الزائر' });
  }
};

export const handleRefreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken, clientType = 'customer' } = req.body || {};
    if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.includes('.')) {
      res.status(401).json({ error: 'Refresh token missing or malformed' });
      return;
    }

    const [tokenId, rawToken] = refreshToken.split('.');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const tokenRes = await pool.query('SELECT * FROM refresh_tokens WHERE id = $1', [tokenId]);
    if (tokenRes.rows.length === 0) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const tokenRow = tokenRes.rows[0];

    // Reuse detection: if token is already revoked, revoke the entire family!
    if (tokenRow.is_revoked) {
      console.warn(`⚠️ [Security Alert] Refresh token reuse detected for family ${tokenRow.family_id}! Revoking family.`);
      await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE family_id = $1', [tokenRow.family_id]);
      res.status(401).json({ error: 'Security breach detected. All sessions in this family revoked.' });
      return;
    }

    // Verify token hash and expiration
    if (tokenRow.token_hash !== tokenHash || new Date(tokenRow.expires_at) < new Date()) {
      await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE id = $1', [tokenId]);
      res.status(401).json({ error: 'Expired or invalid refresh token' });
      return;
    }

    // Fetch user and verify active status
    const userRes = await pool.query('SELECT id, email, role, status, permissions, permission_group_id FROM users WHERE id = $1', [tokenRow.user_id]);
    if (userRes.rows.length === 0) {
      res.status(401).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const user = userRes.rows[0];
    if (user.status === 'banned' || user.status === 'inactive') {
      await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = $1', [user.id]);
      res.status(401).json({ error: 'الحساب محظور أو غير نشط' });
      return;
    }

    // Revoke old token and rotate to a new token in the same family
    await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE id = $1', [tokenId]);

    const newRawRefreshToken = crypto.randomBytes(32).toString('hex');
    const newTokenHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
    const newCountTokenId = generate16CharId();
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, client_type, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newCountTokenId, user.id, newTokenHash, tokenRow.family_id, clientType, newExpiresAt, req.headers['user-agent'] || null, req.ip || null]
    );

    let permissions: string[] = [];
    try {
      permissions = safeParseArray(user.permissions);
      if (user.permission_group_id) {
        const groupRes = await pool.query('SELECT permissions FROM permission_groups WHERE id = $1', [String(user.permission_group_id)]);
        if (groupRes.rows.length > 0) {
          permissions = Array.from(new Set([...permissions, ...safeParseArray(groupRes.rows[0].permissions)]));
        }
      }
    } catch (e) {
      permissions = [];
    }

    const audMap: Record<string, string> = {
      customer: 'sdra-customer',
      company: 'sdra-company',
      admin: 'sdra-admin',
    };
    const newAccessToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, permissions },
      env.JWT_SECRET,
      { expiresIn: '15m', audience: audMap[clientType] || 'sdra-customer', issuer: 'sdra-backend' }
    );

    res.json({
      success: true,
      token: newAccessToken,
      accessToken: newAccessToken,
      refreshToken: `${newCountTokenId}.${newRawRefreshToken}`,
    });
  } catch (error: any) {
    console.error('Error handling refresh token:', error);
    res.status(500).json({ error: 'فشل تجديد الجلسة' });
  }
};

export const logoutUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken && typeof refreshToken === 'string' && refreshToken.includes('.')) {
      const [tokenId] = refreshToken.split('.');
      await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE id = $1', [tokenId]);
    }
    res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
  } catch (error: any) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الخروج' });
  }
};

const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCK_MS = 15 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

const hashOtp = (email: string, code: string): string =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(`${email.toLowerCase()}:${code}`).digest('hex');

const generateAndSendOtp = async (email: string, userName?: string): Promise<void> => {
  const stateRes = await pool.query(
    'SELECT otp_last_sent_at, otp_locked_until FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  const state = stateRes.rows[0];
  const isLocked = state?.otp_locked_until && new Date(state.otp_locked_until) > new Date();
  const sentRecently = state?.otp_last_sent_at && Date.now() - new Date(state.otp_last_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS;
  if (isLocked || sentRecently) return;

  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // otp_attempts is deliberately not reset here, so requesting a new code cannot buy more guesses
  await pool.query(
    `UPDATE users SET otp_code = $1, otp_expires_at = $2, otp_last_sent_at = $3 WHERE LOWER(email) = LOWER($4)`,
    [hashOtp(email, code), expiresAt, new Date(), email]
  );

  try {
    await sendPlatformEmail({
      to: email,
      templateKey: 'verification',
      variables: {
        verification_code: code,
        code,
        user_name: userName || 'العميل الكريم',
      },
      fallbackSubject: 'رمز التحقق الخاص بك - سدرة',
      fallbackHtml: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 24px; background-color: #f8fafc; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0;">
          <h2 style="color: #111827; margin-bottom: 8px;">مرحباً بك في سدّرة</h2>
          <p style="color: #4b5563; font-size: 15px; margin-bottom: 20px;">شكراً لتسجيلك! يرجى استخدام رمز التحقق التالي لإكمال تفعيل حسابك:</p>
          <div style="font-size: 32px; font-weight: bold; color: #1a4d2e; background: #e8f5e9; padding: 18px; border-radius: 12px; text-align: center; letter-spacing: 6px; margin: 24px 0; border: 1px dashed #2e7d32;">
            ${code}
          </div>
          <p style="color: #64748b; font-size: 13px; text-align: center;">رمز التحقق صالح لمدة 10 دقائق فقط.</p>
        </div>
      `,
    });
  } catch (emailErr) {
    console.error('[Mailer] Error sending OTP email:', emailErr);
  }
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone } = req.body;
    const cleanEmail = email.trim().toLowerCase();

    const existingUserResult = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);

    let user: any;

    if (existingUserResult.rows.length > 0) {
      user = existingUserResult.rows[0];
      // An approved company stays unverified until its first login; registering must not overwrite its password
      const ownedCompany = await pool.query('SELECT 1 FROM companies WHERE user_id = $1 LIMIT 1', [user.id]);
      if (user.is_verified || ownedCompany.rows.length > 0) {
        res.status(400).json({ error: 'البريد الإلكتروني مسجل مسبقاً' });
        return;
      }
      // If user exists but is not verified yet, update their info
      const passwordHash = await argon2.hash(password);
      const updateRes = await pool.query(
        `UPDATE users SET name = $1, password_hash = $2, phone = $3 WHERE id = $4 RETURNING id, name, email, phone, role, balance`,
        [name, passwordHash, phone || null, user.id]
      );
      user = updateRes.rows[0];
    } else {
      const passwordHash = await argon2.hash(password);
      const newUserId = generate16CharId();
      const newUserResult = await pool.query(
        `INSERT INTO users (id, name, email, password_hash, phone, role, balance, is_verified)
         VALUES ($1, $2, $3, $4, $5, 'user', 0.00, false)
         RETURNING id, name, email, phone, role, balance`,
        [newUserId, name, cleanEmail, passwordHash, phone || null]
      );
      user = newUserResult.rows[0];
    }

    // Generate & send OTP code to email
    await generateAndSendOtp(cleanEmail, name);

    res.status(201).json({
      success: true,
      requireOtp: true,
      email: cleanEmail,
      message: 'تم إنشاء الحساب وإرسال رمز التحقق إلى بريدك الإلكتروني',
      user: {
        id: formatUserId(user.id),
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي أثناء إنشاء الحساب' });
  }
};

export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    const cleanEmail = email.trim().toLowerCase();

    const userRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    const user = userRes.rows[0];

    // OTP only activates new accounts. The reply is identical either way, so it does not reveal who has an account.
    if (user && user.is_verified === false) {
      await generateAndSendOtp(cleanEmail, user.name);
    }

    res.json({
      success: true,
      message: 'تم إعادة إرسال رمز التحقق بنجاح',
    });
  } catch (error: any) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'فشل إرسال رمز التحقق' });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    const userRes = await pool.query('SELECT id, is_verified FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    const user = userRes.rows[0];

    // A code can never open a session on an already active account
    if (!user || user.is_verified !== false) {
      res.status(400).json({ error: 'رمز التحقق غير صحيح' });
      return;
    }

    // The attempt is counted before comparing, so parallel guesses cannot exceed the limit
    const now = new Date();
    const attemptRes = await pool.query(
      `UPDATE users SET otp_attempts = COALESCE(otp_attempts, 0) + 1, otp_locked_until = NULL
       WHERE id = $1 AND COALESCE(otp_attempts, 0) < $2 AND (otp_locked_until IS NULL OR otp_locked_until <= $3)
       RETURNING otp_code, otp_expires_at, otp_attempts`,
      [user.id, OTP_MAX_ATTEMPTS, now]
    );

    if (attemptRes.rows.length === 0) {
      res.status(429).json({ error: 'محاولات كثيرة غير صحيحة، يرجى المحاولة لاحقاً' });
      return;
    }

    const attempt = attemptRes.rows[0];
    const submitted = Buffer.from(hashOtp(cleanEmail, cleanOtp));
    const stored = Buffer.from(String(attempt.otp_code || ''));
    const isCodeValid = stored.length === submitted.length && crypto.timingSafeEqual(stored, submitted);
    const isExpired = Boolean(attempt.otp_expires_at) && now > new Date(attempt.otp_expires_at);

    if (!isCodeValid || isExpired) {
      if (attempt.otp_attempts >= OTP_MAX_ATTEMPTS) {
        await pool.query(
          'UPDATE users SET otp_attempts = 0, otp_code = NULL, otp_expires_at = NULL, otp_locked_until = $1 WHERE id = $2',
          [new Date(Date.now() + OTP_LOCK_MS), user.id]
        );
      }
      res.status(400).json({ error: isCodeValid ? 'انتهت صلاحية رمز التحقق' : 'رمز التحقق غير صحيح' });
      return;
    }

    // Verify user and clear OTP
    const updatedUserRes = await pool.query(
      `UPDATE users SET is_verified = true, otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_locked_until = NULL
       WHERE id = $1 RETURNING id, name, email, phone, role, balance`,
      [user.id]
    );

    const verifiedUser = updatedUserRes.rows[0];

    // Companies are linked only now that the email is proven to belong to this user
    await pool.query(
      `UPDATE companies SET user_id = $1, pending_owner_email = NULL WHERE LOWER(pending_owner_email) = $2`,
      [verifiedUser.id, cleanEmail]
    );

    const clientType = (verifiedUser.role === 'admin' || verifiedUser.role === 'super_admin') ? 'admin' : (verifiedUser.role === 'owner' ? 'company' : 'customer');
    const { accessToken, refreshToken } = await issueTokenPair(verifiedUser, clientType, req.headers['user-agent'], req.ip);

    res.json({
      success: true,
      message: 'تم التحقق من الحساب بنجاح',
      token: accessToken,
      accessToken,
      refreshToken,
      user: {
        id: formatUserId(verifiedUser.id),
        name: verifiedUser.name,
        email: verifiedUser.email,
        phone: verifiedUser.phone,
        role: verifiedUser.role,
        balance: parseFloat(verifiedUser.balance || 0),
      },
    });
  } catch (error: any) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'فشل التحقق من الرمز' });
  }
};

const RESET_MAX_ATTEMPTS = 5;
const RESET_MAX_SENDS_PER_HOUR = 5;
const BLOCKED_STATUSES = ['banned', 'inactive'];
// Wrong, expired, locked and unknown-email all answer alike, so the reply never reveals whether an account exists
const INVALID_RESET_CODE = 'رمز التحقق غير صحيح أو منتهي الصلاحية، يمكنك طلب رمز جديد';

// Bound to the purpose and the account, so a reset code can never pass as an activation code or for another user
const hashResetCode = (userId: string, code: string): string =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(`password-reset:${userId}:${code}`).digest('hex');

const findUserForReset = async (email: string) => {
  const result = await pool.query(
    'SELECT id, email, password_hash, status FROM users WHERE LOWER(email) = LOWER($1) ORDER BY (email = $1) DESC LIMIT 1',
    [email]
  );
  const user = result.rows[0];
  return user && !BLOCKED_STATUSES.includes(user.status) ? user : null;
};

const sendPasswordResetCode = async (email: string): Promise<void> => {
  const user = await findUserForReset(email);
  if (!user) return;

  const code = crypto.randomInt(100000, 1000000).toString();

  // One statement, so parallel requests cannot slip past the cooldown or the hourly cap.
  // Attempts carry over to the new code, so requesting another one cannot buy more guesses.
  const issued = await pool.query(
    `INSERT INTO password_resets (user_id, code_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (user_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       last_sent_at = NOW(),
       send_count = CASE WHEN password_resets.window_started_at <= NOW() - INTERVAL '1 hour' THEN 1 ELSE password_resets.send_count + 1 END,
       window_started_at = CASE WHEN password_resets.window_started_at <= NOW() - INTERVAL '1 hour' THEN NOW() ELSE password_resets.window_started_at END
     WHERE password_resets.last_sent_at <= NOW() - ($3 * INTERVAL '1 millisecond')
       AND (password_resets.locked_until IS NULL OR password_resets.locked_until <= NOW())
       AND (password_resets.window_started_at <= NOW() - INTERVAL '1 hour' OR password_resets.send_count < $4)
     RETURNING user_id`,
    [user.id, hashResetCode(user.id, code), OTP_RESEND_COOLDOWN_MS, RESET_MAX_SENDS_PER_HOUR]
  );
  if (issued.rows.length === 0) return;

  // Sent to the stored address, never the typed one, which may only match it after case folding
  const sent = await sendPlatformEmail({
    to: user.email,
    fallbackSubject: 'رمز إعادة تعيين كلمة المرور - سدرة',
    fallbackHtml: `
      <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 24px; background-color: #f8fafc; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0;">
        <h2 style="color: #111827; margin-bottom: 8px;">إعادة تعيين كلمة المرور</h2>
        <p style="color: #4b5563; font-size: 15px; margin-bottom: 20px;">استخدم الرمز التالي لتعيين كلمة مرور جديدة لحسابك:</p>
        <div style="font-size: 32px; font-weight: bold; color: #1a4d2e; background: #e8f5e9; padding: 18px; border-radius: 12px; text-align: center; letter-spacing: 6px; margin: 24px 0; border: 1px dashed #2e7d32;">
          ${code}
        </div>
        <p style="color: #64748b; font-size: 13px;">الرمز صالح لمدة 10 دقائق. لا تشاركه مع أي شخص، فلن يطلبه منك فريق سدرة أبداً.</p>
        <p style="color: #64748b; font-size: 13px;">إذا لم تطلب ذلك فتجاهل هذه الرسالة، وستبقى كلمة مرورك كما هي.</p>
      </div>
    `,
  });
  if (!sent) console.error('[Password reset] The reset email could not be sent');
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  // Answered before any lookup, so neither the reply nor its timing reveals whether the account exists
  res.json({
    success: true,
    message: 'إذا كان هذا البريد مسجلاً لدينا فستصلك رسالة برمز إعادة التعيين خلال دقائق',
  });

  sendPasswordResetCode(req.body.email.trim()).catch((error) => {
    console.error('Forgot password error:', error);
  });
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    const { email, code, newPassword } = req.body;
    const user = await findUserForReset(email.trim());

    if (!user) {
      res.status(400).json({ error: INVALID_RESET_CODE });
      return;
    }

    // The attempt is counted before comparing, so parallel guesses cannot exceed the limit
    const attemptRes = await pool.query(
      `UPDATE password_resets SET attempts = attempts + 1
       WHERE user_id = $1 AND code_hash IS NOT NULL AND expires_at > NOW()
         AND attempts < $2 AND (locked_until IS NULL OR locked_until <= NOW())
       RETURNING code_hash, attempts`,
      [user.id, RESET_MAX_ATTEMPTS]
    );

    if (attemptRes.rows.length === 0) {
      res.status(400).json({ error: INVALID_RESET_CODE });
      return;
    }

    const attempt = attemptRes.rows[0];
    const submitted = Buffer.from(hashResetCode(user.id, code));
    const stored = Buffer.from(String(attempt.code_hash));

    if (stored.length !== submitted.length || !crypto.timingSafeEqual(stored, submitted)) {
      if (attempt.attempts >= RESET_MAX_ATTEMPTS) {
        await pool.query(
          `UPDATE password_resets SET attempts = 0, code_hash = NULL, expires_at = NULL, locked_until = $1 WHERE user_id = $2`,
          [new Date(Date.now() + OTP_LOCK_MS), user.id]
        );
      }
      res.status(400).json({ error: INVALID_RESET_CODE });
      return;
    }

    // Only reached with the right code, so the code stays valid and this reveals nothing to a stranger
    let isSamePassword = user.password_hash === newPassword;
    if (String(user.password_hash || '').startsWith('$')) {
      isSamePassword = await argon2.verify(user.password_hash, newPassword);
    }
    if (isSamePassword) {
      res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' });
      return;
    }

    const newHash = await argon2.hash(newPassword);

    client = await pool.connect();
    await client.query('BEGIN');
    inTransaction = true;

    // Deleting by the hash makes the code single use even when two correct requests race
    const consumed = await client.query(
      'DELETE FROM password_resets WHERE user_id = $1 AND code_hash = $2 RETURNING user_id',
      [user.id, attempt.code_hash]
    );
    if (consumed.rows.length === 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      res.status(400).json({ error: INVALID_RESET_CODE });
      return;
    }

    // The code proved the mailbox, so an account that was still waiting for activation is activated too
    await client.query(
      `UPDATE users SET password_hash = $1, is_verified = true,
         otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_locked_until = NULL
       WHERE id = $2`,
      [newHash, user.id]
    );
    await client.query(
      `UPDATE companies SET user_id = $1, pending_owner_email = NULL WHERE LOWER(pending_owner_email) = LOWER($2)`,
      [user.id, user.email]
    );
    // Whoever knew the old password loses their sessions on every app
    await client.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = $1', [user.id]);

    await client.query('COMMIT');
    inTransaction = false;

    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح، يمكنك تسجيل الدخول الآن' });

    // Tells the real owner if this was not them. Not awaited: the password has already changed.
    sendPlatformEmail({
      to: user.email,
      fallbackSubject: 'تم تغيير كلمة مرور حسابك - سدرة',
      fallbackHtml: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; padding: 24px; background-color: #f8fafc; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e2e8f0;">
          <h2 style="color: #111827; margin-bottom: 8px;">تم تغيير كلمة المرور</h2>
          <p style="color: #4b5563; font-size: 15px;">تم تغيير كلمة مرور حسابك وتسجيل خروجك من جميع الأجهزة.</p>
          <p style="color: #b91c1c; font-size: 14px;">إذا لم تقم بذلك، فأعد تعيين كلمة المرور فوراً وتواصل مع الدعم الفني.</p>
        </div>
      `,
    }).catch((error) => console.error('[Password reset] Confirmation email failed:', error));
  } catch (error: any) {
    if (inTransaction) await client?.query('ROLLBACK').catch(() => {});
    console.error('Reset password error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'تعذر تغيير كلمة المرور، يرجى المحاولة لاحقاً' });
  } finally {
    client?.release();
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    const userResult = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) ORDER BY (email = $1) DESC LIMIT 1',
      [email.trim()]
    );
    if (userResult.rows.length === 0) {
      res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
      return;
    }

    const user = userResult.rows[0];

    // Verify password safely (handles both argon2 hash and legacy/unhashed passwords)
    let validPassword = false;
    if (!user.password_hash || !user.password_hash.startsWith('$')) {
      if (user.password_hash === password) {
        validPassword = true;
        const newHash = await argon2.hash(password);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
      }
    } else {
      validPassword = await argon2.verify(user.password_hash, password);
    }

    if (!validPassword) {
      res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
      return;
    }

    // Admins and Super Admins bypass OTP verification; regular users must be verified
    const isAdminRole = user.role === 'admin' || user.role === 'super_admin';
    if (!isAdminRole && user.is_verified === false) {
      await generateAndSendOtp(user.email, user.name);
      res.status(401).json({
        error: 'يرجى تفعيل حسابك أولاً عن طريق إدخال رمز التحقق المرسل لبريدك الإلكتروني',
        requireOtp: true,
        email: user.email,
      });
      return;
    }

    // Resolve permissions (direct + permission group)
    let permissions: string[] = [];
    try {
      const userPerms = safeParseArray(user.permissions);
      permissions = [...userPerms];

      if (user.permission_group_id) {
        const groupRes = await pool.query('SELECT permissions FROM permission_groups WHERE id = $1', [user.permission_group_id]);
        if (groupRes.rows.length > 0) {
          const groupPerms = safeParseArray(groupRes.rows[0].permissions);
          permissions = Array.from(new Set([...permissions, ...groupPerms]));
        }
      }
    } catch (e) {
      permissions = [];
    }

    const clientType = (user.role === 'admin' || user.role === 'super_admin') ? 'admin' : (user.role === 'owner' ? 'company' : 'customer');
    const { accessToken, refreshToken } = await issueTokenPair({ ...user, permissions }, clientType, req.headers['user-agent'], req.ip);

    res.json({
      message: 'تم تسجيل الدخول بنجاح',
      token: accessToken,
      accessToken,
      refreshToken,
      user: {
        id: formatUserId(user.id),
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        balance: user.balance ? parseFloat(user.balance) : 0,
        permissions,
        permission_group_id: user.permission_group_id,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي أثناء تسجيل الدخول' });
  }
};

export const getUserProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.params.id;
    const userResult = await pool.query('SELECT id, name, email, phone, address, country, city, role, balance FROM users WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const user = userResult.rows[0];

    res.json({
      id: formatUserId(user.id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: user.address,
      country: user.country,
      city: user.city,
      role: user.role,
      balance: parseFloat(user.balance || 0),
    });
  } catch (error: any) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
  }
};

export const updateUserProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.params.id;
    const authUserId = req.user?.id;
    const userRole = req.user?.role;

    if (!authUserId || (authUserId !== userId && userRole !== 'admin')) {
      res.status(403).json({ error: 'غير مصرح لك بتعديل بيانات هذا المستخدم' });
      return;
    }

    // Email is not editable here: it is the account identity and changing it needs proof of ownership
    const { name, phone, country, city, avatar } = req.body;

    const currentRes = await pool.query('SELECT avatar FROM users WHERE id = $1', [userId]);
    const safeAvatar = await resolveUserUpload(avatar, req, String(userId), currentRes.rows[0]?.avatar);
    if (safeAvatar === false) {
      res.status(400).json({ error: 'رابط الصورة غير صالح' });
      return;
    }

    const result = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), country = COALESCE($3, country), city = COALESCE($4, city), avatar = COALESCE($5, avatar) WHERE id = $6 RETURNING id, name, email, phone, role, balance, country, city, avatar, created_at`,
      [name, phone, country, city, safeAvatar, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const updated = result.rows[0];
    updated.id = formatUserId(updated.id);

    res.json({
      success: true,
      message: 'تم تحديث الملف الشخصي بنجاح',
      data: updated,
    });
  } catch (error: any) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث الملف الشخصي' });
  }
};

export const getProfileStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }
    const userRes = await pool.query('SELECT name, phone, country, city FROM users WHERE id = $1', [String(userId)]);
    const settingsRes = await pool.query('SELECT value FROM settings WHERE key = $1', ['profile_required_fields']);
    const enforcedRes = await pool.query('SELECT value FROM settings WHERE key = $1', ['profile_completion_enforced']);

    let requiredFields = ['name', 'phone'];
    try {
      if (settingsRes.rows.length > 0) {
        requiredFields = JSON.parse(settingsRes.rows[0].value);
      }
    } catch {}

    const enforced = enforcedRes.rows.length > 0 ? enforcedRes.rows[0].value !== 'false' : true;
    const user = userRes.rows[0] || {};

    let missingFields: string[] = [];
    if (enforced) {
      for (const field of requiredFields) {
        if (!user[field] || String(user[field]).trim() === '') {
          missingFields.push(field);
        }
      }
    }

    res.json({
      success: true,
      data: {
        isComplete: missingFields.length === 0,
        missingFields,
        enforced
      }
    });
  } catch (error: any) {
    console.error('Error checking profile status:', error);
    res.status(500).json({ error: 'فشل التحقق من حالة الملف الشخصي' });
  }
};

export const getCurrentUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const userResult = await pool.query(
      `SELECT u.*, pg.name as permission_group_name
       FROM users u
       LEFT JOIN permission_groups pg ON u.permission_group_id = pg.id
       WHERE u.id = $1`,
      [String(req.user.id)]
    );
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const user = userResult.rows[0];

    // Resolve permissions (direct + permission group)
    let permissions: string[] = [];
    try {
      const userPerms = safeParseArray(user.permissions);
      permissions = [...userPerms];

      if (user.permission_group_id) {
        const groupRes = await pool.query('SELECT permissions FROM permission_groups WHERE id = $1', [String(user.permission_group_id)]);
        if (groupRes.rows.length > 0) {
          const groupPerms = safeParseArray(groupRes.rows[0].permissions);
          permissions = Array.from(new Set([...permissions, ...groupPerms]));
        }
      }
    } catch (e) {
      permissions = [];
    }

    res.json({
      success: true,
      data: {
        id: formatUserId(user.id),
        name: user.name,
        email: user.email,
        phone: user.phone || '',
        address: user.address || '',
        country: user.country || '',
        city: user.city || '',
        avatar: user.avatar || null,
        role: user.role,
        permissions,
        permission_group_id: user.permission_group_id,
        permission_group_name: user.permission_group_name,
      },
    });
  } catch (error: any) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
};

export const updateMyProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const userId = req.user.id;
    const { name, email, phone, address, currentPassword, newPassword } = req.body;

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }
    const user = userRes.rows[0];

    let newPasswordHash = user.password_hash;
    if (newPassword && newPassword.trim()) {
      if (!currentPassword) {
        res.status(400).json({ error: 'يرجى إدخال كلمة المرور الحالية لتغيير كلمة المرور' });
        return;
      }
      let validPass = false;
      try {
        validPass = await argon2.verify(user.password_hash, currentPassword);
      } catch (e) {
        validPass = user.password_hash === currentPassword;
      }
      if (!validPass) {
        res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
        return;
      }
      newPasswordHash = await argon2.hash(newPassword);
      // Revoke all refresh tokens for user on password change
      await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = $1', [userId]);
    }

    const result = await pool.query(
      `UPDATE users
       SET name = COALESCE(NULLIF($1, ''), name),
           phone = COALESCE($2, phone),
           address = COALESCE($3, address),
           password_hash = $4
       WHERE id = $5 RETURNING id, name, email, phone, address, country, city, role, permissions, permission_group_id`,
      [name, phone, address, newPasswordHash, userId]
    );

    const updatedUser = result.rows[0];

    res.json({
      success: true,
      message: 'تم تحديث بيانات ملفك الشخصي بنجاح',
      data: updatedUser,
    });
  } catch (error: any) {
    console.error('Error updating my profile:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث الملف الشخصي' });
  }
};

export const googleLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const settingsRes = await pool.query('SELECT value FROM settings WHERE key = $1', ['google_login_enabled']);
    const googleEnabled = settingsRes.rows.length > 0 ? settingsRes.rows[0].value === 'true' : false;

    if (!googleEnabled) {
      res.status(403).json({ error: 'تسجيل الدخول بواسطة جوجل معطل حالياً من قبل الإدارة' });
      return;
    }

    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'رمز جوجل مطلوب لتسجيل الدخول، يرجى تحديث التطبيق' });
      return;
    }

    // Identity comes only from a token signed by Google for one of our client IDs
    const clientsRes = await pool.query(
      `SELECT value FROM settings WHERE key IN ('google_client_id_web', 'google_client_id_android', 'google_client_id_ios')`
    );
    const allowedAudiences = clientsRes.rows.map(row => String(row.value || '').trim()).filter(Boolean);
    const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    const googlePayload: any = googleRes.ok ? await googleRes.json() : null;
    const email = googlePayload?.email;
    const name = googlePayload?.name;

    if (!email || String(googlePayload.email_verified) !== 'true' || !allowedAudiences.includes(googlePayload.aud)) {
      res.status(401).json({ error: 'تعذر التحقق من حساب جوجل' });
      return;
    }

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user: any;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      isNewUser = true;
      const randomPasswordHash = await argon2.hash(crypto.randomBytes(32).toString('hex'));
      const newUserId = generate16CharId();
      const insertRes = await pool.query(
        `INSERT INTO users (id, name, email, password_hash, role, balance, is_verified)
         VALUES ($1, $2, $3, $4, 'user', 0.00, true)
         RETURNING id, name, email, phone, role, balance`,
        [newUserId, name || email.split('@')[0], email, randomPasswordHash]
      );
      user = insertRes.rows[0];

      await pool.query(
        `UPDATE companies SET user_id = $1, pending_owner_email = NULL WHERE LOWER(pending_owner_email) = LOWER($2)`,
        [user.id, email]
      );
    } else {
      user = userResult.rows[0];

      // Google proved the email. A password set on a never-verified account may be someone else's, so it is replaced.
      if (user.is_verified === false) {
        const randomPasswordHash = await argon2.hash(crypto.randomBytes(32).toString('hex'));
        await pool.query(
          'UPDATE users SET is_verified = true, password_hash = $1, otp_code = NULL, otp_expires_at = NULL WHERE id = $2',
          [randomPasswordHash, user.id]
        );
      }
    }

    // Resolve permissions (direct + permission group)
    let permissions: string[] = [];
    try {
      const userPerms = safeParseArray(user.permissions);
      permissions = [...userPerms];

      if (user.permission_group_id) {
        const groupRes = await pool.query('SELECT permissions FROM permission_groups WHERE id = $1', [String(user.permission_group_id)]);
        if (groupRes.rows.length > 0) {
          const groupPerms = safeParseArray(groupRes.rows[0].permissions);
          permissions = Array.from(new Set([...permissions, ...groupPerms]));
        }
      }
    } catch (e) {
      permissions = [];
    }

    const clientType = (user.role === 'admin' || user.role === 'super_admin') ? 'admin' : (user.role === 'owner' ? 'company' : 'customer');
    const { accessToken, refreshToken } = await issueTokenPair({ ...user, permissions }, clientType, req.headers['user-agent'], req.ip);

    res.json({
      message: 'تم تسجيل الدخول بواسطة جوجل بنجاح',
      isNewUser,
      token: accessToken,
      accessToken,
      refreshToken,
      user: {
        id: formatUserId(user.id),
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        permissions,
        balance: parseFloat(user.balance || 0),
      },
    });
  } catch (error: any) {
    console.error('Google login error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الدخول بواسطة جوجل' });
  }
};

export const deleteMyAccount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }
    const userId = req.user.id;
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({
      success: true,
      message: 'تم حذف حسابك بنجاح',
    });
  } catch (error: any) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء حذف الحساب' });
  }
};
