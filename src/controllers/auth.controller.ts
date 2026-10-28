import { Request, Response } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { safeParseArray } from '../middlewares/permission.middleware';
import { formatUserId, generate16CharId } from '../utils/formatId';
import { sendPlatformEmail } from '../utils/mailer';

const generateAndSendOtp = async (email: string, userName?: string): Promise<{ code: string; expiresAt: Date }> => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await pool.query(
    `UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE LOWER(email) = LOWER($3)`,
    [code, expiresAt, email]
  );

  console.log(`🔑 ==========================================`);
  console.log(`🔑 [OTP Code for ${email}]: ${code}`);
  console.log(`🔑 ==========================================`);

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

  return { code, expiresAt };
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone } = req.body;
    const cleanEmail = email.trim().toLowerCase();

    const existingUserResult = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);

    let user: any;

    if (existingUserResult.rows.length > 0) {
      user = existingUserResult.rows[0];
      if (user.is_verified) {
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

    // Auto-link any pending companies created for this email
    await pool.query(
      `UPDATE companies SET user_id = $1, pending_owner_email = NULL WHERE LOWER(pending_owner_email) = $2`,
      [user.id, cleanEmail]
    );

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
    if (userRes.rows.length === 0) {
      res.status(404).json({ error: 'الحساب غير موجود' });
      return;
    }

    const user = userRes.rows[0];
    await generateAndSendOtp(cleanEmail, user.name);

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

    const userRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    if (userRes.rows.length === 0) {
      res.status(404).json({ error: 'الحساب غير موجود' });
      return;
    }

    const user = userRes.rows[0];

    if (!user.otp_code || user.otp_code !== cleanOtp) {
      res.status(400).json({ error: 'رمز التحقق غير صحيح' });
      return;
    }

    if (user.otp_expires_at && new Date() > new Date(user.otp_expires_at)) {
      res.status(400).json({ error: 'انتهت صلاحية رمز التحقق' });
      return;
    }

    // Verify user and clear OTP
    const updatedUserRes = await pool.query(
      `UPDATE users SET is_verified = true, otp_code = NULL, otp_expires_at = NULL WHERE id = $1 RETURNING id, name, email, phone, role, balance`,
      [user.id]
    );

    const verifiedUser = updatedUserRes.rows[0];

    const token = jwt.sign(
      { id: verifiedUser.id, email: verifiedUser.email, role: verifiedUser.role },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN } as any
    );

    res.json({
      success: true,
      message: 'تم التحقق من الحساب بنجاح',
      token,
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

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, permissions },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN } as any
    );

    res.json({
      message: 'تم تسجيل الدخول بنجاح',
      token,
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

    const { name, phone, email, country, city } = req.body;

    const result = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email), country = COALESCE($4, country), city = COALESCE($5, city) WHERE id = $6 RETURNING id, name, email, phone, role, balance, country, city, created_at`,
      [name, phone, email, country, city, userId]
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
    }

    const result = await pool.query(
      `UPDATE users
       SET name = COALESCE(NULLIF($1, ''), name),
           email = COALESCE(NULLIF($2, ''), email),
           phone = COALESCE($3, phone),
           address = COALESCE($4, address),
           password_hash = $5
       WHERE id = $6 RETURNING id, name, email, phone, address, country, city, role, permissions, permission_group_id`,
      [name, email, phone, address, newPasswordHash, userId]
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

    const { email, name, googleId } = req.body;
    if (!email) {
      res.status(400).json({ error: 'البريد الإلكتروني مطلوب لتسجيل الدخول بجوجل' });
      return;
    }

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user: any;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      isNewUser = true;
      const randomPasswordHash = await argon2.hash(Math.random().toString(36) + 'GoogleAuth');
      const newUserId = generate16CharId();
      const insertRes = await pool.query(
        `INSERT INTO users (id, name, email, password_hash, role, balance)
         VALUES ($1, $2, $3, $4, 'user', 0.00)
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, permissions },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN } as any
    );

    res.json({
      message: 'تم تسجيل الدخول بواسطة جوجل بنجاح',
      isNewUser,
      token,
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
