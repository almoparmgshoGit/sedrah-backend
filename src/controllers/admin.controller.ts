import { disconnectUserSockets } from '../server';
import { Response, Request } from 'express';
import { pool } from '../config/db';
import type { PoolClient } from 'pg';
import { AuthRequest } from '../middlewares/security.middleware';
import { formatUserId, formatCompanyId, formatPackageId, parseIdOrToken, generateRandomToken, generate16CharId } from '../utils/formatId';
import { enrichPackage, PACKAGE_EXTRA_COLUMNS, lowestAdultPrice } from '../utils/packageInfo';
import dns from 'dns';
import net from 'net';
import { logAudit } from '../utils/auditLogger';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { replaceEmailPlaceholders } from '../utils/mailer';
import { createAndSendNotification } from '../utils/notificationHelper';
import { markAppointmentAttended } from '../utils/appointmentLifecycle';
import { notifyCompanyTeam, recalcCompanyRating } from '../utils/companyAccess';
import { companyReadySql } from '../utils/companyReadiness';
import { companyActiveSql } from '../utils/companySuspension';
import { resolveAdminAlerts } from '../utils/adminAlerts';
import { ownerConflict, afterOwnerChange } from '../utils/companyOwner';

const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];
// Both bypass every module permission, so only a super admin can grant or touch them
const FULL_ACCESS_ROLES = ['super_admin', 'owner'];

// Roles and permissions are only changeable by people who manage staff
const canManageStaff = async (req: AuthRequest): Promise<boolean> => {
  if (req.user?.role === 'super_admin') return true;
  const res = await pool.query(
    `SELECT u.permissions AS direct, pg.permissions AS grouped
     FROM users u LEFT JOIN permission_groups pg ON u.permission_group_id = pg.id
     WHERE u.id = $1`,
    [req.user?.id]
  );
  const row = res.rows[0] || {};
  return `${row.direct || ''} ${row.grouped || ''}`.includes('admins');
};

// Audit logs keep only these user fields, never the password hash or tokens
const safeUserSnapshot = (row: any) => {
  if (!row) return null;
  return {
    id: row.id,
    public_id: row.public_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.status,
    permissions: row.permissions,
    permission_group_id: row.permission_group_id,
  };
};

// Ends every session of the user so new roles, permissions or a ban apply at once
const revokeUserSessions = async (userId: string) => {
  await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = $1', [String(userId)]);
  try { disconnectUserSockets(String(userId)); } catch { /* socket server may not be ready */ }
};

const countSuperAdmins = async (): Promise<number> => {
  const result = await pool.query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'super_admin'`);
  return Number(result.rows[0]?.total || 0);
};

const normalizePermissions = (value: any): string => {
  if (value === undefined || value === null || value === '') return '[]';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return JSON.stringify(Array.isArray(parsed) ? [...parsed].map(String).sort() : []);
  } catch {
    return '[]';
  }
};

const resolveUserId = async (param: string | number) => {
  const str = String(param);
  const res = await pool.query('SELECT id FROM users WHERE id = $1 OR public_id = $1', [str]);
  return res.rows.length > 0 ? res.rows[0].id : null;
};

export const getAllUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.phone, u.role, COALESCE(u.status, 'active') as status, u.permissions, u.permission_group_id, u.created_at, u.public_id,
             pg.name as permission_group_name
      FROM users u
      LEFT JOIN permission_groups pg ON u.permission_group_id = pg.id
      ORDER BY u.created_at DESC
    `);
    const users = result.rows.map(user => {
      let perms = [];
      try {
        if (user.permissions) {
          perms = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
        }
      } catch (e) {
        perms = [];
      }

      return {
        id: user.public_id || formatUserId(user.id),
        name: user.name,
        email: user.email,
        phone: user.phone || null,
        role: user.role || 'user',
        createdAt: user.created_at,
        status: user.status || 'active',
        permissions: perms,
        permission_group_id: user.permission_group_id,
        permission_group_name: user.permission_group_name,
      };
    });

    res.json({ success: true, data: users });
  } catch (error: any) {
    console.error('Error fetching users for admin:', error);
    res.status(500).json({ error: 'فشل جلب المستخدمين' });
  }
};

export const getUserDetails = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const userRes = await pool.query('SELECT id, name, email, phone, role, country, city, status, created_at, public_id FROM users WHERE id = $1', [internalUserId]);
    const user = userRes.rows[0];

    // Fetch user bookings/trips
    const bookingsRes = await pool.query(`
      SELECT b.*, p.title as package_title, c.name as company_name
      FROM bookings b
      LEFT JOIN packages p ON b.package_id = p.id
      LEFT JOIN companies c ON p.company_id = c.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `, [internalUserId]);

    // Fetch user reviews
    const reviewsRes = await pool.query(`
      SELECT r.*, c.name as company_name FROM reviews r
      LEFT JOIN companies c ON r.company_id = c.id
      WHERE r.user_id = $1
    `, [internalUserId]);

    // Fetch user store orders
    const storeOrdersRes = await pool.query(`
      SELECT o.*,
              (SELECT JSON_AGG(i.*) FROM store_order_items i WHERE i.order_id = o.id) as items
      FROM store_orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [internalUserId]);

    // Fetch company owned or associated with user if any
    const companyRes = await pool.query(
      'SELECT * FROM companies WHERE user_id = $1 OR LOWER(pending_owner_email) = LOWER($2) LIMIT 1',
      [internalUserId, user.email]
    );
    let companyData = null;
    let companyBookings = [];
    let companyPackages = [];
    let companyDocuments = [];

    if (companyRes.rows.length > 0) {
      const comp = companyRes.rows[0];
      comp.public_id = comp.public_id || formatCompanyId(comp.id);
      companyData = comp;

      // Fetch company packages/trips
      const pkgRes = await pool.query('SELECT * FROM packages WHERE company_id = $1 ORDER BY created_at DESC', [comp.id]);
      companyPackages = pkgRes.rows;

      // Fetch company bookings
      const compBookingsRes = await pool.query(`
        SELECT b.*, p.title as package_title, u.name as customer_name
        FROM bookings b
        JOIN packages p ON b.package_id = p.id
        LEFT JOIN users u ON b.user_id = u.id
        WHERE p.company_id = $1
        ORDER BY b.created_at DESC
      `, [comp.id]);
      companyBookings = compBookingsRes.rows;

      // Fetch official company documents
      const docsRes = await pool.query(`
        SELECT d.* FROM documents d
        JOIN bookings b ON d.booking_id = b.id
        JOIN packages p ON b.package_id = p.id
        WHERE p.company_id = $1
      `, [comp.id]);
      companyDocuments = docsRes.rows;
    }

    res.json({
      success: true,
      data: {
        profile: {
          id: user.public_id || formatUserId(user.id),
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          country: user.country || '',
          city: user.city || '',
          status: user.status || 'active',
          createdAt: user.created_at,
        },
        bookings: bookingsRes.rows,
        storeOrders: storeOrdersRes.rows,
        reviews: reviewsRes.rows,
        company: companyData,
        companyBookings,
        companyPackages,
        companyDocuments,
      }
    });
  } catch (error: any) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ error: 'فشل جلب تفاصيل المستخدم' });
  }
};

export const createUserByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, role, permissions, permission_group_id } = req.body;
    if (!email) {
      res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
      return;
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const existing = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);

    const manageStaff = await canManageStaff(req);
    const requestsStaffAccess = (role && role !== 'user') || (Array.isArray(permissions) && permissions.length > 0) || permission_group_id;
    if (!manageStaff && requestsStaffAccess) {
      res.status(403).json({ error: 'ليس لديك صلاحية منح أدوار أو صلاحيات إدارية' });
      return;
    }
    if (FULL_ACCESS_ROLES.includes(role) && req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'منح دور المشرف العام متاح للمشرف العام فقط' });
      return;
    }
    // An existing account is only promoted when the admins page asks for it explicitly
    if (existing.rows.length > 0 && req.body?.promote !== true) {
      res.status(409).json({ error: 'هذا البريد مسجل مسبقاً' });
      return;
    }
    if (existing.rows.length > 0 && !manageStaff) {
      res.status(403).json({ error: 'ترقية المستخدمين تتطلب صلاحية إدارة المشرفين' });
      return;
    }
    if (existing.rows.length > 0 && FULL_ACCESS_ROLES.includes(existing.rows[0].role) && req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'لا يمكن تعديل حساب مشرف عام' });
      return;
    }

    const permsStr = Array.isArray(permissions) ? JSON.stringify(permissions) : JSON.stringify([]);
    const parsedGroupId = permission_group_id ? String(permission_group_id) : null;

    let targetUser;

    if (existing.rows.length > 0) {
      // Promotes an existing account: role, permissions and group only. The password is never changed here.
      const user = existing.rows[0];
      const nextRole = role || user.role;
      const nextPerms = permissions === undefined
        ? user.permissions
        : (Array.isArray(permissions) ? JSON.stringify(permissions) : JSON.stringify([]));
      const nextGroup = permission_group_id === undefined ? user.permission_group_id : parsedGroupId;
      const accessChanged = nextRole !== user.role
        || normalizePermissions(nextPerms) !== normalizePermissions(user.permissions)
        || String(nextGroup ?? '') !== String(user.permission_group_id ?? '');

      if (accessChanged && String(user.id) === String(req.user?.id)) {
        res.status(403).json({ error: 'لا يمكنك تعديل دورك أو صلاحياتك بنفسك' });
        return;
      }
      if (user.role === 'super_admin' && nextRole !== 'super_admin' && (await countSuperAdmins()) <= 1) {
        res.status(409).json({ error: 'لا يمكن تخفيض آخر مشرف عام في المنصة' });
        return;
      }

      const updateRes = await pool.query(
        `UPDATE users SET
           name = COALESCE($1, name),
           role = $2,
           permissions = $3,
           permission_group_id = $4,
           is_verified = true
         WHERE id = $5
         RETURNING id, name, email, phone, role, status, permissions, permission_group_id, created_at, public_id`,
        [name || user.name, nextRole, nextPerms, nextGroup, user.id]
      );
      targetUser = updateRes.rows[0];
      if (accessChanged) await revokeUserSessions(user.id);

      await logAudit(
        req.user?.email || 'admin@sdra.com',
        'ترقية / تحديث صلاحيات مستخدم',
        `تم تحديث صلاحيات ونظام المستخدم "${targetUser.name}" (${targetUser.email}) إلى دور: ${targetUser.role}`,
        req.ip,
        req.user?.email || 'المسؤول',
        safeUserSnapshot(user),
        safeUserSnapshot(targetUser)
      );
    } else {
      // User does not exist -> Create new user with password & name
      if (!name || !password) {
        res.status(400).json({ error: 'الاسم وكلمة المرور مطلوبان لإنشاء حساب جديد' });
        return;
      }
      const passwordHash = await argon2.hash(password);
      const publicId = generateRandomToken('usr');
      const newUserId = generateRandomToken('usr');
      const insertRes = await pool.query(
        `INSERT INTO users (id, name, email, password_hash, phone, role, status, permissions, permission_group_id, public_id, is_verified)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, true)
         RETURNING id, name, email, phone, role, status, permissions, permission_group_id, created_at, public_id`,
        [newUserId, name, cleanEmail, passwordHash, phone || null, role || 'user', permsStr, parsedGroupId, publicId]
      );
      targetUser = insertRes.rows[0];

      await logAudit(
        req.user?.email || 'admin@sdra.com',
        'إنشاء مستخدم جديد',
        `تم إنشاء مستخدم جديد "${targetUser.name}" (${targetUser.email}) - الدور: ${targetUser.role}`,
        req.ip,
        req.user?.email || 'المسؤول',
        null,
        safeUserSnapshot(targetUser)
      );
    }

    let savedPermissions: any[] = [];
    try {
      const parsed = typeof targetUser.permissions === 'string' ? JSON.parse(targetUser.permissions) : targetUser.permissions;
      savedPermissions = Array.isArray(parsed) ? parsed : [];
    } catch {
      savedPermissions = [];
    }

    res.status(200).json({
      success: true,
      message: existing.rows.length > 0 ? 'تم تحديث وترقية المستخدم بنجاح' : 'تم إنشاء المستخدم بنجاح',
      data: {
        id: targetUser.public_id || targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        phone: targetUser.phone,
        role: targetUser.role,
        permission_group_id: targetUser.permission_group_id,
        createdAt: targetUser.created_at,
        status: targetUser.status,
        permissions: savedPermissions
      }
    });
  } catch (error: any) {
    console.error('Error creating/updating user by admin:', error);
    res.status(500).json({ error: 'فشل معالجة بيانات المستخدم' });
  }
};

export const lookupUserByEmail = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { email } = req.query;
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'البريد الإلكتروني مطلوب للبحث' });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const result = await pool.query(
      'SELECT id, name, email, phone, role, status FROM users WHERE LOWER(email) = $1',
      [cleanEmail]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'لم يتم العثور على أي مستخدم مسجل بهذا البريد الإلكتروني' });
      return;
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Error looking up user:', error);
    res.status(500).json({ error: 'فشل البحث عن المستخدم' });
  }
};

export const updateUserByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const { name, email, phone, role, country, city, permissions, permission_group_id, password } = req.body;

    const currentRes = await pool.query(
      'SELECT id, public_id, name, email, phone, role, status, permissions, permission_group_id FROM users WHERE id = $1',
      [internalUserId]
    );
    const current = currentRes.rows[0] || {};
    const changesStaffAccess = (role !== undefined && role !== current.role) || permissions !== undefined || permission_group_id !== undefined;
    if (changesStaffAccess && !(await canManageStaff(req))) {
      res.status(403).json({ error: 'ليس لديك صلاحية تعديل الأدوار أو الصلاحيات' });
      return;
    }

    const roleChanged = role !== undefined && role !== null && role !== '' && role !== current.role;
    const permissionsChanged = permissions !== undefined && permissions !== null
      && normalizePermissions(permissions) !== normalizePermissions(current.permissions);
    const groupChanged = permission_group_id !== undefined
      && String(permission_group_id || '') !== String(current.permission_group_id ?? '');
    const accessChanged = roleChanged || permissionsChanged || groupChanged;

    if (accessChanged && String(internalUserId) === String(req.user?.id)) {
      res.status(403).json({ error: 'لا يمكنك تعديل دورك أو صلاحياتك بنفسك' });
      return;
    }
    if (roleChanged && current.role === 'super_admin' && (await countSuperAdmins()) <= 1) {
      res.status(409).json({ error: 'لا يمكن تخفيض آخر مشرف عام في المنصة' });
      return;
    }

    const changesPassword = password !== undefined && password !== null && password !== '';
    if (changesPassword) {
      if (typeof password !== 'string' || password.length < 8) {
        res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
        return;
      }
      if (STAFF_ROLES.includes(current.role) && !(await canManageStaff(req))) {
        res.status(403).json({ error: 'تغيير كلمة مرور المشرفين يتطلب صلاحية إدارة المشرفين' });
        return;
      }
    }
    // Changing a staff member's email is a route to taking over their account
    const changesStaffEmail = email !== undefined && email !== current.email && STAFF_ROLES.includes(current.role);
    if (changesStaffEmail && !(await canManageStaff(req))) {
      res.status(403).json({ error: 'تعديل بريد المشرفين يتطلب صلاحية إدارة المشرفين' });
      return;
    }
    if ((FULL_ACCESS_ROLES.includes(role) || FULL_ACCESS_ROLES.includes(current.role)) && req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'تعديل حسابات المشرف العام متاح للمشرف العام فقط' });
      return;
    }

    const permsStr = permissions ? (Array.isArray(permissions) ? JSON.stringify(permissions) : String(permissions)) : null;

    let parsedGroupId: string | null = null;
    if (permission_group_id !== undefined && permission_group_id !== null && permission_group_id !== '') {
      parsedGroupId = String(permission_group_id);
    }

    const result = await pool.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         phone = COALESCE($3, phone),
         role = COALESCE($4, role),
         country = COALESCE($5, country),
         city = COALESCE($6, city),
         permissions = COALESCE($7, permissions),
         permission_group_id = CASE WHEN $8::boolean THEN $9::text ELSE permission_group_id END,
         is_verified = true
       WHERE id = $10 RETURNING id, name, email, phone, role, country, city, status, permissions, permission_group_id, created_at, public_id`,
      [
        name,
        email,
        phone,
        role,
        country,
        city,
        permsStr,
        permission_group_id !== undefined,
        parsedGroupId,
        internalUserId
      ]
    );

    const updatedUser = result.rows[0];

    if (changesPassword) {
      const passwordHash = await argon2.hash(password);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, internalUserId]);
    }
    if (changesPassword || accessChanged) {
      await revokeUserSessions(internalUserId);
    }

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'تحديث بيانات مستخدم',
      `تم تحديث بيانات المستخدم "${updatedUser.name}" (${updatedUser.email})${changesPassword ? ' مع تغيير كلمة المرور' : ''}`,
      req.ip,
      req.user?.email || 'المسؤول',
      safeUserSnapshot(current),
      safeUserSnapshot(updatedUser)
    );

    res.json({ success: true, message: 'تم تحديث بيانات المستخدم بنجاح', data: updatedUser });
  } catch (error: any) {
    console.error('Error updating user by admin:', error);
    res.status(500).json({ error: 'فشل تحديث بيانات المستخدم' });
  }
};

export const banUserByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const newStatus = req.body?.status === 'active' ? 'active' : 'banned';

    const targetRes = await pool.query('SELECT role FROM users WHERE id = $1', [internalUserId]);
    if (String(internalUserId) === String(req.user?.id)) {
      res.status(400).json({ error: 'لا يمكنك حظر حسابك' });
      return;
    }
    if (STAFF_ROLES.includes(targetRes.rows[0]?.role) && !(await canManageStaff(req))) {
      res.status(403).json({ error: 'حظر المشرفين يتطلب صلاحية إدارة المشرفين' });
      return;
    }
    if (FULL_ACCESS_ROLES.includes(targetRes.rows[0]?.role) && req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'لا يمكن حظر مشرف عام' });
      return;
    }
    if (newStatus === 'banned' && targetRes.rows[0]?.role === 'super_admin' && (await countSuperAdmins()) <= 1) {
      res.status(409).json({ error: 'لا يمكن حظر آخر مشرف عام في المنصة' });
      return;
    }

    await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      [newStatus, internalUserId]
    );
    if (newStatus === 'banned') await revokeUserSessions(internalUserId);

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'تغيير حالة حظر المستخدم',
      `تم تغيير حالة المستخدم رقم ${internalUserId} إلى (${newStatus})`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      { userId: internalUserId, status: newStatus }
    );

    res.json({ success: true, message: `تم تحديث حالة الحظر بنجاح إلى: ${newStatus}` });
  } catch (error: any) {
    console.error('Error banning user:', error);
    res.status(500).json({ error: 'فشل تغيير حالة الحظر' });
  }
};

export const setCompanyOwner = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const companyId = String(req.params.id);
    const { userId, replace } = req.body || {};

    const companyRes = await pool.query('SELECT * FROM companies WHERE id = $1 OR public_id = $1', [companyId]);
    if (companyRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }
    const company = companyRes.rows[0];

    let ownerId: string | null = null;
    if (userId) {
      ownerId = await resolveUserId(String(userId));
      if (!ownerId) {
        res.status(404).json({ error: 'المستخدم غير موجود' });
        return;
      }
      if (company.user_id && String(company.user_id) !== String(ownerId) && !replace) {
        res.status(409).json({ error: 'هذه الشركة مرتبطة بمستخدم آخر' });
        return;
      }
      const conflict = await ownerConflict(company, ownerId);
      if (conflict) {
        res.status(409).json({ error: conflict });
        return;
      }
    }

    const updated = await pool.query(
      'UPDATE companies SET user_id = $1, pending_owner_email = NULL WHERE id = $2 RETURNING *',
      [ownerId, company.id]
    );

    const previousOwner = company.user_id ? String(company.user_id) : null;
    await afterOwnerChange(company, previousOwner, ownerId);

    await logAudit(
      req.user?.email || 'admin',
      ownerId ? 'ربط شركة بمالك' : 'فك ربط شركة من مالكها',
      `الشركة "${company.name}" - المالك: ${ownerId || 'بدون'}`,
      req.ip,
      req.user?.email,
      { user_id: company.user_id },
      { user_id: ownerId }
    );

    res.json({ success: true, message: ownerId ? 'تم ربط الشركة بالمستخدم' : 'تم فك ربط الشركة', data: updated.rows[0] });
  } catch (error: any) {
    console.error('Error setting company owner:', error);
    res.status(500).json({ error: 'فشل تحديث مالك الشركة' });
  }
};

export const deleteUserByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const targetRes = await pool.query('SELECT role FROM users WHERE id = $1', [internalUserId]);
    if (String(internalUserId) === String(req.user?.id)) {
      res.status(400).json({ error: 'لا يمكنك حذف حسابك من هنا' });
      return;
    }
    if (STAFF_ROLES.includes(targetRes.rows[0]?.role) && !(await canManageStaff(req))) {
      res.status(403).json({ error: 'حذف المشرفين يتطلب صلاحية إدارة المشرفين' });
      return;
    }
    if (FULL_ACCESS_ROLES.includes(targetRes.rows[0]?.role) && req.user?.role !== 'super_admin') {
      res.status(403).json({ error: 'لا يمكن حذف مشرف عام' });
      return;
    }
    if (targetRes.rows[0]?.role === 'super_admin' && (await countSuperAdmins()) <= 1) {
      res.status(409).json({ error: 'لا يمكن حذف آخر مشرف عام في المنصة' });
      return;
    }

    await pool.query('DELETE FROM users WHERE id = $1', [internalUserId]);
    await revokeUserSessions(internalUserId);

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'حذف مستخدم',
      `تم حذف المستخدم رقم ${internalUserId} نهائياً`,
      req.ip,
      req.user?.email || 'المسؤول',
      { userId: internalUserId },
      null
    );

    res.json({ success: true, message: 'تم حذف المستخدم بنجاح' });
  } catch (error: any) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'فشل حذف المستخدم' });
  }
};

export const getAllBookings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query(`
      UPDATE bookings b
      SET status = 'completed'
      WHERE b.status = 'confirmed' AND b.receipt_approved = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id AND ts.status != 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM platform_earnings pe WHERE pe.booking_id = b.id AND pe.status = 'cancelled'
      )
    `);
    const result = await pool.query(`
      SELECT b.*, COALESCE(b.customer_name, u.name) as customer_name, COALESCE(b.customer_phone, u.phone) as customer_phone,
             p.title as package_title, c.name as company_name
      FROM bookings b
      LEFT JOIN users u ON b.user_id = u.id
      LEFT JOIN packages p ON b.package_id = p.id
      LEFT JOIN companies c ON p.company_id = c.id
      ORDER BY b.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'فشل جلب الحجوزات' });
  }
};

const companyIdOfBooking = async (bookingId: string): Promise<string | null> => {
  const result = await pool.query('SELECT p.company_id FROM bookings b JOIN packages p ON b.package_id = p.id WHERE b.id = $1', [bookingId]);
  return result.rows[0]?.company_id || null;
};

// Status moves an admin may make by hand. Confirming and receipt review belong to the receipts module,
// and finished bookings (cancelled or completed) cannot be reopened.
const ADMIN_BOOKING_TRANSITIONS: Record<string, string[]> = {
  new: ['cancelled'],
  pending: ['cancelled'],
  receipt_review: ['cancelled'],
  confirmed: ['cancelled', 'completed'],
  completed: [],
  cancelled: [],
};

/**
 * Checks a manual booking status change inside the caller's transaction (the booking row is already locked).
 * Returns the HTTP error to send, or null when the move is allowed.
 */
const bookingTransitionError = async (
  client: PoolClient,
  booking: any,
  nextStatus: string,
  reason: string
): Promise<{ code: number; error: string } | null> => {
  const currentStatus = booking.status || 'new';
  if (nextStatus === 'confirmed' || nextStatus === 'receipt_review') {
    return { code: 409, error: 'تأكيد الحجز ومراجعة الإيصال يتمان من قسم الإيصالات فقط' };
  }
  if (!(ADMIN_BOOKING_TRANSITIONS[currentStatus] || []).includes(nextStatus)) {
    if (currentStatus === 'cancelled') return { code: 409, error: 'هذا الحجز ملغي ولا يمكن إعادة تفعيله' };
    if (currentStatus === 'completed') return { code: 409, error: 'هذا الحجز مكتمل ولا يمكن تغيير حالته' };
    return { code: 409, error: 'لا يمكن نقل الحجز إلى هذه الحالة من حالته الحالية' };
  }
  if (nextStatus === 'completed' && booking.receipt_approved !== true) {
    return { code: 409, error: 'لا يمكن إكمال الحجز قبل اعتماد إيصال الدفع من قسم الإيصالات' };
  }
  if (nextStatus === 'cancelled') {
    if (!reason) {
      return { code: 400, error: 'يرجى كتابة سبب الإلغاء' };
    }
    const earning = await client.query(
      'SELECT status, settlement_id FROM platform_earnings WHERE booking_id = $1 FOR UPDATE',
      [booking.id]
    );
    const settled = earning.rows.some((row: any) => row.settlement_id && row.status !== 'cancelled');
    if (settled) {
      return { code: 409, error: 'لا يمكن إلغاء هذا الحجز لأن عمولته سُوّيت بالفعل مع الشركة' };
    }
  }
  return null;
};

export const updateBookingStatusByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const { cancelled_by, appointment_date, appointment_time, appointment_status } = req.body;
    const requestedStatus = req.body.status ? String(req.body.status) : undefined;
    const rawReason = req.body.reason ?? req.body.cancellation_reason;
    const cancellation_reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 500) : '';

    const client = await pool.connect();
    let result: any;
    let status: string | undefined;
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
      const current = locked.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'الحجز غير موجود' });
        return;
      }
      const currentStatus = current.status || 'new';
      // Sending the current status again changes nothing (the appointment form does that)
      status = requestedStatus && requestedStatus !== currentStatus ? requestedStatus : undefined;

      if (status) {
        const check = await bookingTransitionError(client, current, status, cancellation_reason);
        if (check) {
          await client.query('ROLLBACK');
          res.status(check.code).json({ error: check.error });
          return;
        }
      }

      if (status === 'cancelled') {
        // Only commission that was not settled yet can be dropped; settled bookings were refused above
        await client.query(
          `UPDATE platform_earnings SET status = 'cancelled' WHERE booking_id = $1 AND settlement_id IS NULL`,
          [id]
        );
        await client.query(`UPDATE trip_stages SET status = 'cancelled' WHERE booking_id = $1 AND status <> 'completed'`, [id]);
      }

      result = await client.query(
      `UPDATE bookings
       SET status = COALESCE($1, status),
           receipt_approved = CASE
             WHEN $1 = 'confirmed' THEN TRUE
             WHEN $1 IN ('receipt_review', 'pending', 'new', 'cancelled') THEN FALSE
             ELSE receipt_approved
           END,
           receipt_status = CASE
             WHEN $1 = 'confirmed' THEN 'approved'
             WHEN $1 = 'receipt_review' OR $1 = 'pending' OR $1 = 'new' THEN 'pending'
             WHEN $1 = 'cancelled' THEN 'rejected'
             ELSE receipt_status
           END,
           cancellation_reason = CASE WHEN $1 = 'cancelled' THEN COALESCE($3, cancellation_reason) ELSE cancellation_reason END,
           cancelled_by = CASE WHEN $1 = 'cancelled' THEN COALESCE($4, cancelled_by) ELSE cancelled_by END,
           appointment_date = COALESCE($5, appointment_date),
           appointment_time = COALESCE($6, appointment_time),
           appointment_status = COALESCE($7, appointment_status)
       WHERE id = $2
       RETURNING *`,
      [
        status || null,
        id,
        cancellation_reason || null,
        cancelled_by || 'admin',
        appointment_date || null,
        appointment_time || null,
        appointment_status || null,
      ]
    );
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK').catch(() => {});
      throw txError;
    } finally {
      client.release();
    }
    const booking = result.rows[0];

    // If appointment details updated, update stage 1 subtitle
    if (appointment_date || appointment_time) {
      const cleanDate = booking.appointment_date ? String(booking.appointment_date).split('T')[0] : (appointment_date || '');
      const cleanTime = booking.appointment_time || appointment_time || '10:00 ص';
      const apptSub = `موعد الزيارة المحدد: ${cleanDate} الساعة ${cleanTime}`;
      await pool.query(
        `UPDATE trip_stages SET subtitle = $1 WHERE booking_id = $2 AND stage_order = 1`,
        [apptSub, booking.id]
      );
      await createAndSendNotification({
        userId: booking.user_id,
        title: 'تحديث موعد مراجعة الشركة',
        subtitle: `تم تحديد وتأكيد موعد لمراجعة الشركة لحجزك رقم #${booking.booking_reference} بتاريخ ${cleanDate} الساعة ${cleanTime}`,
        category: 'booking',
        icon: 'calendar-outline',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        data: { type: 'appointment_update', bookingRef: booking.booking_reference },
      });
    }

    // Send notification to user
    const statusLabels: Record<string, string> = {
      new: 'طلب جديد',
      receipt_review: 'قيد مراجعة الإيصال',
      confirmed: 'مؤكد',
      completed: 'مكتمل',
      cancelled: 'ملغي'
    };
    // Only an actual status change is announced (appointment-only updates send no status)
    if (status) {
      const notifBody = `تم تحديث حالة حجزك رقم #${booking.booking_reference} إلى: ${statusLabels[status] || status}${status === 'cancelled' && cancellation_reason ? `. السبب: ${cancellation_reason}` : ''}`;
      await createAndSendNotification({
        userId: booking.user_id,
        title: 'تحديث حالة الحجز',
        subtitle: notifBody,
        category: 'booking',
        icon: 'notifications-outline',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        data: { type: 'booking_status', status, bookingRef: booking.booking_reference },
      });
    }

    // The company hears about changes the platform makes; its own cancellations come through here too and are skipped
    if (cancelled_by !== 'company') {
      const companyId = await companyIdOfBooking(String(booking.id));
      if (status) {
        const labels: Record<string, string> = { new: 'طلب جديد', confirmed: 'مؤكد', completed: 'مكتمل', cancelled: 'ملغي' };
        await notifyCompanyTeam(companyId, 'orders.view', {
          title: status === 'cancelled' ? 'ألغت الإدارة حجزاً' : 'عدّلت الإدارة حالة حجز',
          subtitle: status === 'cancelled'
            ? `ألغت إدارة سدرة الحجز #${booking.booking_reference}${cancellation_reason ? `. السبب: ${cancellation_reason}` : ''}`
            : `غيّرت إدارة سدرة حالة الحجز #${booking.booking_reference} إلى: ${labels[status] || status}`,
          category: 'booking',
          icon: status === 'cancelled' ? 'close-circle-outline' : 'swap-horizontal-outline',
          iconBg: status === 'cancelled' ? '#FEF2F2' : '#EFF6FF',
          iconColor: status === 'cancelled' ? '#DC2626' : '#2563EB',
          data: { type: 'admin_booking_update', bookingId: booking.id, bookingRef: booking.booking_reference, status },
        });
      }
      if (appointment_date || appointment_time) {
        await notifyCompanyTeam(companyId, 'appointments.view', {
          title: 'حددت الإدارة موعد زيارة',
          subtitle: `حددت إدارة سدرة موعد زيارة العميل للحجز #${booking.booking_reference}: ${String(booking.appointment_date || appointment_date).split('T')[0]} ${booking.appointment_time || appointment_time || ''}`,
          category: 'booking',
          icon: 'calendar-outline',
          iconBg: '#EFF6FF',
          iconColor: '#2563EB',
          data: { type: 'admin_booking_update', bookingId: booking.id, bookingRef: booking.booking_reference },
        });
      }
    }

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'تحديث حالة الحجز',
      status
        ? `تم تحديث حالة الحجز رقم #${booking.booking_reference} إلى (${status})${status === 'cancelled' ? ` - السبب: ${cancellation_reason}` : ''}`
        : `تم تحديث موعد الحجز رقم #${booking.booking_reference}`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      { id: booking.id, booking_reference: booking.booking_reference, status: booking.status, cancellation_reason: booking.cancellation_reason, appointment_date: booking.appointment_date, appointment_time: booking.appointment_time }
    );

    res.json({ success: true, message: 'تم تحديث حالة الحجز بنجاح', data: booking });
  } catch (error: any) {
    console.error('Error updating booking status:', error);
    res.status(500).json({ error: 'فشل تحديث حالة الحجز' });
  }
};

export const updateTripStageByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, stageId } = req.params;
    const { status, traveler_name, document_url, document_number, details } = req.body;
    if (status !== undefined && status !== null && !['pending', 'current', 'completed', 'cancelled'].includes(status)) {
      res.status(400).json({ error: 'حالة المرحلة غير صالحة' });
      return;
    }
    const rawReason = req.body.reason ?? details;
    const cancelReason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 500) : '';

    const bookingCheck = await pool.query('SELECT status FROM bookings WHERE id = $1', [id]);
    if (bookingCheck.rows.length > 0 && bookingCheck.rows[0].status === 'cancelled') {
      res.status(400).json({ error: 'لا يمكن تعديل أو تحديث مراحل الرحلة لحجز تم إلغاؤه' });
      return;
    }

    const stageRes = await pool.query('SELECT * FROM trip_stages WHERE id = $1 AND booking_id = $2', [stageId, id]);
    if (stageRes.rows.length === 0) {
      res.status(404).json({ error: 'مرحلة الرحلة غير موجودة' });
      return;
    }
    const targetStage = stageRes.rows[0];

    // Prerequisite validation: previous stage must be completed if trying to complete this one
    if (targetStage.stage_order > 1 && status === 'completed') {
      const prevStageRes = await pool.query(
        'SELECT * FROM trip_stages WHERE booking_id = $1 AND stage_order = $2',
        [id, targetStage.stage_order - 1]
      );
      if (prevStageRes.rows.length > 0 && prevStageRes.rows[0].status !== 'completed') {
        res.status(400).json({ error: 'لا يمكن إتمام هذه المرحلة قبل إنجاز المرحلة السابقة لها' });
        return;
      }
    }

    // Prerequisite validation: receipt must be approved before completing stages > 2
    if (targetStage.stage_order > 2 && status === 'completed') {
      const bookingRes = await pool.query('SELECT receipt_approved FROM bookings WHERE id = $1', [id]);
      if (bookingRes.rows.length > 0 && !bookingRes.rows[0].receipt_approved) {
        res.status(400).json({ error: 'لا يمكن إتمام مراحل الرحلة قبل موافقة واعتماد إيصال الدفع من قبل إدارة المنصة' });
        return;
      }
    }

    const stageUpdateSql = `UPDATE trip_stages
       SET status = COALESCE($1, status),
           traveler_name = COALESCE($2, traveler_name),
           document_url = COALESCE($3, document_url),
           document_number = COALESCE($4, document_number),
           details = COALESCE($5, details)
       WHERE id = $6 AND booking_id = $7 RETURNING *`;
    const stageUpdateParams = [status, traveler_name, document_url, document_number, details, stageId, id];
    let result: any;

    if (status === 'cancelled') {
      // Cancelling a stage cancels the whole booking, so it follows the same rules as a booking cancellation
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
        if (!locked.rows[0]) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'الحجز غير موجود' });
          return;
        }
        const check = await bookingTransitionError(client, locked.rows[0], 'cancelled', cancelReason);
        if (check) {
          await client.query('ROLLBACK');
          res.status(check.code).json({ error: check.error });
          return;
        }
        result = await client.query(stageUpdateSql, stageUpdateParams);
        await client.query(
          `UPDATE platform_earnings SET status = 'cancelled' WHERE booking_id = $1 AND settlement_id IS NULL`,
          [id]
        );
        await client.query(
          `UPDATE bookings
           SET status = 'cancelled',
               cancellation_reason = $1,
               cancelled_by = 'admin'
           WHERE id = $2`,
          [cancelReason, id]
        );
        // Set all stages for this booking to 'cancelled'
        await client.query(`UPDATE trip_stages SET status = 'cancelled' WHERE booking_id = $1`, [id]);
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK').catch(() => {});
        throw txError;
      } finally {
        client.release();
      }
    } else {
      result = await pool.query(stageUpdateSql, stageUpdateParams);
    }

    // Completing the visit stage means the customer came, so the appointment counts as attended
    if (targetStage.stage_order === 1 && status === 'completed') {
      const owner = await pool.query(
        `SELECT b.user_id, c.name AS company_name FROM bookings b
         JOIN packages p ON b.package_id = p.id JOIN companies c ON p.company_id = c.id WHERE b.id = $1`,
        [id]
      );
      if (owner.rows[0]?.user_id) {
        await markAppointmentAttended(owner.rows[0].user_id, owner.rows[0].company_name, String(id)).catch(() => {});
      }
    }

    // Auto-update booking status to completed if all stages are completed (only a confirmed booking can complete)
    await pool.query(`
      UPDATE bookings b
      SET status = 'completed'
      WHERE b.id = $1 AND b.status = 'confirmed' AND b.receipt_approved = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id AND ts.status != 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM platform_earnings pe WHERE pe.booking_id = b.id AND pe.status = 'cancelled'
      )
    `, [id]);

    // Send notification to user
    const bookingRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (bookingRes.rows.length > 0) {
      const booking = bookingRes.rows[0];
      const stageStatusLabels: Record<string, string> = {
        pending: 'قريباً',
        current: 'قيد التنفيذ',
        completed: 'مكتمل',
        cancelled: 'متوقف'
      };
      let extraInfo = '';
      if (traveler_name) extraInfo += ` (للمسافر: ${traveler_name})`;
      if (document_number) extraInfo += ` (رقم المرجع/الغرفة: ${document_number})`;

      const stageLabel = status ? (stageStatusLabels[status] || status) : (stageStatusLabels[targetStage.status] || targetStage.status);
      const notifBody = status
        ? `حجزك #${booking.booking_reference}: تم تحديث مرحلة "${targetStage.title}" إلى (${stageLabel})${extraInfo}`
        : `حجزك #${booking.booking_reference}: تم تحديث بيانات مرحلة "${targetStage.title}"${extraInfo}`;
      await createAndSendNotification({
        userId: booking.user_id,
        title: 'تحديث مراحل الرحلة',
        subtitle: notifBody,
        category: 'stage',
        icon: 'flag-outline',
        iconBg: '#F0FDF4',
        iconColor: '#16A34A',
        data: { type: 'stage_update', stageTitle: targetStage.title, bookingRef: booking.booking_reference },
      });
      await notifyCompanyTeam(await companyIdOfBooking(String(id)), 'trips.view', {
        title: status === 'cancelled' ? 'ألغت الإدارة حجزاً' : 'حدّثت الإدارة مرحلة رحلة',
        subtitle: status === 'cancelled'
          ? `ألغت إدارة سدرة الحجز #${booking.booking_reference} من مرحلة "${targetStage.title}"`
          : `حدّثت إدارة سدرة مرحلة "${targetStage.title}" في الحجز #${booking.booking_reference} إلى (${stageLabel})`,
        category: 'booking',
        icon: 'flag-outline',
        iconBg: '#F0FDF4',
        iconColor: '#16A34A',
        data: { type: 'admin_stage_update', bookingId: booking.id, bookingRef: booking.booking_reference },
      });
    }

    res.json({ success: true, message: 'تم تحديث مرحلة الرحلة بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating trip stage:', error);
    res.status(500).json({ error: 'فشل تحديث مرحلة الرحلة' });
  }
};

export const getBookingStagesByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const stagesRes = await pool.query(
      'SELECT * FROM trip_stages WHERE booking_id = $1 ORDER BY stage_order ASC',
      [id]
    );
    res.json({ success: true, data: stagesRes.rows });
  } catch (error: any) {
    console.error('Error fetching admin booking stages:', error);
    res.status(500).json({ error: 'فشل جلب مراحل الحجز' });
  }
};

export const getAllCompanies = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { cityId, minRating, verification_type, search, sort, status } = req.query;
    // is_ready: whether customers can see the company (complete profile and a published package)
    let query = `
      SELECT c.*,
             ${companyReadySql('c')} AS is_ready,
             NOT ${companyActiveSql('c')} AS is_suspended,
             ci.name AS city_name,
             COALESCE(b_stats.total_bookings, 0)::int AS total_bookings,
             COALESCE(b_stats.completed_bookings, 0)::int AS completed_bookings,
             COALESCE(b_stats.in_progress_bookings, 0)::int AS in_progress_bookings,
             COALESCE(b_stats.cancelled_bookings, 0)::int AS cancelled_bookings,
             COALESCE(pe_stats.total_earnings, 0)::float AS platform_earnings,
             CASE
               WHEN c.field_verified = TRUE THEN 'field'
               WHEN c.verified = TRUE THEN 'document'
               ELSE 'none'
             END AS verification_type
      FROM companies c
      LEFT JOIN cities ci ON c.city_id = ci.id
      LEFT JOIN (
        SELECT p.company_id,
               COUNT(b.id) AS total_bookings,
               COUNT(b.id) FILTER (WHERE b.status = 'completed') AS completed_bookings,
               COUNT(b.id) FILTER (WHERE b.status IN ('new', 'pending', 'receipt_review', 'confirmed')) AS in_progress_bookings,
               COUNT(b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled_bookings
        FROM bookings b
        JOIN packages p ON b.package_id = p.id
        GROUP BY p.company_id
      ) b_stats ON c.id = b_stats.company_id
      LEFT JOIN (
        SELECT company_id, SUM(commission_amount) AS total_earnings
        FROM platform_earnings
        WHERE status = 'recorded'
        GROUP BY company_id
      ) pe_stats ON c.id = pe_stats.company_id
    `;
    const conditions: string[] = [];
    const params: any[] = [];

    if (typeof cityId === 'string' && cityId.trim() && cityId !== 'all') {
      params.push(parseIdOrToken(cityId.trim()).value);
      conditions.push(`c.city_id = $${params.length}`);
    }
    const rating = typeof minRating === 'string' ? parseFloat(minRating) : NaN;
    if (Number.isFinite(rating) && rating > 0 && rating <= 5) {
      params.push(rating);
      conditions.push(`COALESCE(c.rating, 0) >= $${params.length}`);
    }
    if (verification_type === 'field') {
      conditions.push('c.field_verified = TRUE');
    } else if (verification_type === 'document') {
      conditions.push('c.verified = TRUE AND (c.field_verified IS NOT TRUE)');
    } else if (verification_type === 'none') {
      conditions.push('(c.verified IS NOT TRUE) AND (c.field_verified IS NOT TRUE)');
    }
    if (typeof search === 'string' && search.trim()) {
      params.push(`%${search.trim().slice(0, 100)}%`);
      conditions.push(`(c.name ILIKE $${params.length} OR c.short_description ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
    }
    if (status === 'suspended') {
      conditions.push(`NOT ${companyActiveSql('c')}`);
    } else if (status === 'active') {
      conditions.push(companyActiveSql('c'));
    }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');

    const SORTS: Record<string, string> = {
      rating_desc: 'c.rating DESC NULLS LAST, c.created_at DESC',
      earnings_desc: 'platform_earnings DESC, c.created_at DESC',
      bookings_desc: 'total_bookings DESC, c.created_at DESC',
      created_desc: 'c.created_at DESC',
    };
    query += ` ORDER BY ${SORTS[typeof sort === 'string' ? sort : ''] || SORTS.created_desc}`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'فشل جلب الشركات' });
  }
};

// Every package of every company and status, in the same shape as the public GET /packages plus `status`
export const getAllPackagesByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { cityId, companyId, minPrice, maxPrice, status, search } = req.query;
    let query = `
      SELECT p.*, COALESCE(p.status, 'active') AS status, c.name as company_name, c.logo_url as company_logo,
             ci.name as city_name, c.public_id as company_public_id,
             (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) as bookings_count, ${PACKAGE_EXTRA_COLUMNS}
      FROM packages p
      JOIN companies c ON p.company_id = c.id
      LEFT JOIN cities ci ON p.city_id = ci.id
      WHERE TRUE
    `;
    const params: any[] = [];

    if (typeof cityId === 'string' && cityId.trim() && cityId !== 'all') {
      params.push(parseIdOrToken(cityId.trim()).value);
      query += ` AND p.city_id = $${params.length}`;
    }
    if (typeof companyId === 'string' && companyId.trim() && companyId !== 'all') {
      params.push(companyId.trim());
      query += ` AND (p.company_id = $${params.length} OR c.public_id = $${params.length} OR c.name = $${params.length})`;
    }
    const min = typeof minPrice === 'string' ? parseFloat(minPrice) : NaN;
    if (Number.isFinite(min)) {
      params.push(min);
      query += ` AND p.price >= $${params.length}`;
    }
    const max = typeof maxPrice === 'string' ? parseFloat(maxPrice) : NaN;
    if (Number.isFinite(max)) {
      params.push(max);
      query += ` AND p.price <= $${params.length}`;
    }
    if (typeof status === 'string' && ['active', 'paused', 'hidden'].includes(status)) {
      params.push(status);
      query += status === 'active' ? ` AND (p.status = $${params.length} OR p.status IS NULL)` : ` AND p.status = $${params.length}`;
    }
    if (typeof search === 'string' && search.trim()) {
      params.push(`%${search.trim().slice(0, 100)}%`);
      query += ` AND (p.title ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
    }

    query += ' ORDER BY p.created_at DESC';

    const result = await pool.query(query, params);
    const formatted = result.rows.map((pkg) => ({
      ...enrichPackage(pkg),
      numeric_id: pkg.id,
      id: formatPackageId(pkg.id, pkg.public_id),
      company_id: formatCompanyId(pkg.company_id, pkg.company_public_id),
      bookings_count: parseInt(pkg.bookings_count || '0', 10),
      status: pkg.status,
    }));
    res.json({ success: true, data: formatted });
  } catch (error: any) {
    console.error('Error fetching admin packages:', error);
    res.status(500).json({ error: 'فشل جلب الباقات' });
  }
};

/**
 * Runs before the admin package update: when room prices change, the package's listed price becomes the
 * cheapest adult room, the same rule the company app uses, so search and sorting stay correct.
 */
export const syncPackagePriceFromRooms = (req: AuthRequest, _res: Response, next: () => void): void => {
  const roomPrices = req.body?.room_prices;
  if (roomPrices !== undefined && roomPrices !== null && roomPrices !== '') {
    const lowest = lowestAdultPrice(roomPrices);
    if (lowest !== null) req.body.price = lowest;
  }
  next();
};

export const getAllCities = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.image_url,
        c.banner_url,
        c.description,
        c.created_at,
        COALESCE(comp.total_companies, 0)::INTEGER AS total_companies,
        COALESCE(pkg.total_packages, 0)::INTEGER AS total_packages
      FROM cities c
      LEFT JOIN (
        SELECT city_id, COUNT(*)::INTEGER AS total_companies
        FROM companies
        WHERE city_id IS NOT NULL
        GROUP BY city_id
      ) comp ON c.id = comp.city_id
      LEFT JOIN (
        SELECT city_id, COUNT(*)::INTEGER AS total_packages
        FROM packages
        WHERE city_id IS NOT NULL
        GROUP BY city_id
      ) pkg ON c.id = pkg.city_id
      ORDER BY c.created_at ASC
    `);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching cities:', error);
    res.status(500).json({ error: 'فشل جلب المدن' });
  }
};

export const getAllReviews = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT r.*, u.name as user_name, c.name as company_name
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN companies c ON r.company_id = c.id
      ORDER BY r.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: 'فشل جلب التقييمات' });
  }
};

export const deleteReviewByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const revCheck = await pool.query('SELECT * FROM reviews WHERE id = $1', [id]);
    if (revCheck.rows.length === 0) {
      res.status(404).json({ error: 'التقييم غير موجود' });
      return;
    }
    const rev = revCheck.rows[0];

    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);
    await recalcCompanyRating(rev.company_id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    await notifyCompanyTeam(rev.company_id, 'reviews.view', {
      title: 'حذفت الإدارة تقييماً',
      subtitle: `حذفت إدارة سدرة تقييماً (${Number(rev.rating)} نجوم) لمخالفته سياسة المنصة${reason ? `: ${reason}` : ''}. تم تحديث تقييم شركتكم.`,
      category: 'review',
      icon: 'trash-outline',
      iconBg: '#FEF2F2',
      iconColor: '#DC2626',
      data: { type: 'review_removed', reviewId: id },
    });

    await logAudit(req.user?.email || 'admin', 'حذف تقييم', `تم حذف تقييم العميل برقم ${id} نهائياً`, req.ip, req.user?.email || 'المسؤول');
    res.json({ success: true, message: 'تم حذف التقييم بنجاح' });
  } catch (error: any) {
    console.error('Error deleting review:', error);
    res.status(500).json({ error: 'فشل حذف التقييم' });
  }
};

export const toggleHideReviewByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const revCheck = await pool.query('SELECT hidden FROM reviews WHERE id = $1', [id]);
    if (revCheck.rows.length === 0) {
      res.status(404).json({ error: 'التقييم غير موجود' });
      return;
    }
    const currentHidden = revCheck.rows[0].hidden;
    const newHidden = !currentHidden;

    const result = await pool.query('UPDATE reviews SET hidden = $1 WHERE id = $2 RETURNING *', [newHidden, id]);
    const rev = result.rows[0];
    await recalcCompanyRating(rev.company_id);
    await notifyCompanyTeam(rev.company_id, 'reviews.view', {
      title: newHidden ? 'أخفت الإدارة تقييماً' : 'أعادت الإدارة إظهار تقييم',
      subtitle: newHidden
        ? `أخفت إدارة سدرة تقييماً (${Number(rev.rating)} نجوم) لمراجعته، ولا يُحتسب في تقييم شركتكم حالياً.`
        : `أعادت إدارة سدرة إظهار تقييم (${Number(rev.rating)} نجوم) وأصبح يُحتسب في تقييم شركتكم.`,
      category: 'review',
      icon: newHidden ? 'eye-off-outline' : 'eye-outline',
      iconBg: '#F8F5EE',
      iconColor: '#C8A96A',
      data: { type: newHidden ? 'review_hidden' : 'review_shown', reviewId: id },
    });

    await logAudit(req.user?.email || 'admin', newHidden ? 'إخفاء تقييم' : 'إظهار تقييم', `تم ${newHidden ? 'إخفاء' : 'إظهار'} التقييم برقم ${id} مؤقتاً`, req.ip, req.user?.email || 'المسؤول');
    res.json({ success: true, message: newHidden ? 'تم إخفاء التقييم مؤقتاً' : 'تم إظهار التقييم بنجاح', data: rev });
  } catch (error: any) {
    console.error('Error toggling review visibility:', error);
    res.status(500).json({ error: 'فشل تغيير حالة إخفاء التقييم' });
  }
};

export const getAuditLogs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'فشل جلب سجلات التدقيق والأمان' });
  }
};

// Keys the settings page manages; anything else is ignored unless it already exists in the table
const ALLOWED_SETTING_KEYS = new Set([
  'platform_name', 'support_email', 'support_phone', 'whatsapp_number', 'website_url', 'company_address', 'currency',
  'commission_system_enabled', 'commission_method', 'commission_percentage', 'adult_commission_rate', 'child_commission_rate',
  'fixed_commission_amount', 'platform_commission_fee',
  'smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'smtp_from_email', 'smtp_from_name', 'smtp_reply_to',
  'google_login_enabled', 'google_client_id_web', 'google_client_id_android', 'google_client_id_ios', 'google_redirect_uri',
  'privacy_policy_title', 'privacy_policy_content', 'privacy_policy_status', 'packages_disclaimer_note',
  'about_us_content', 'terms_content', 'support_whatsapp_hours', 'support_email_note',
  'profile_required_fields', 'profile_completion_enforced', 'auth_require_email_verification', 'auth_password_min_length',
  'email_templates', 'shipping_mode', 'unified_shipping_fee',
]);

// [min, max] for settings that must be numbers
const NUMERIC_SETTINGS: Record<string, [number, number]> = {
  commission_percentage: [0, 100],
  adult_commission_rate: [0, 100],
  child_commission_rate: [0, 100],
  fixed_commission_amount: [0, 10000000],
  platform_commission_fee: [0, 10000000],
  unified_shipping_fee: [0, 10000000],
  auth_password_min_length: [4, 128],
  smtp_port: [1, 65535],
};

const SECRET_SETTING_KEYS = ['smtp_pass'];
const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525];

// Private, loopback, link-local and other non-public addresses an SMTP test must never reach
const isPrivateAddress = (address: string): boolean => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower === '::' || lower === '::1' || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea')
      || lower.startsWith('feb') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff');
  }
  return true;
};

export const getSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM settings ORDER BY key ASC');
    const settingsObj: Record<string, any> = {};
    for (const row of result.rows) {
      settingsObj[row.key] = row.value;
    }
    // The SMTP password never leaves the server; the page only learns whether one is saved
    settingsObj.smtp_pass_set = Boolean(settingsObj.smtp_pass);
    settingsObj.smtp_pass = '';
    res.json({ success: true, data: settingsObj });
  } catch (error: any) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'فشل جلب إعدادات النظام' });
  }
};

export const updateSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settingsMap = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const existingRes = await pool.query('SELECT key, value FROM settings');
    const existing: Record<string, string> = {};
    for (const row of existingRes.rows) existing[row.key] = row.value;

    // Validate everything first so a bad value saves nothing
    const updates: Array<[string, string]> = [];
    for (const key of Object.keys(settingsMap)) {
      if (!ALLOWED_SETTING_KEYS.has(key) && !(key in existing)) continue;
      const raw = settingsMap[key];
      if (raw === undefined || raw === null) continue;
      const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      // An empty password field means "keep the saved one"
      if (key === 'smtp_pass' && value === '') continue;
      if (existing[key] === value) continue;
      const range = NUMERIC_SETTINGS[key];
      if (range) {
        const amount = Number(value);
        if (value.trim() === '' || !Number.isFinite(amount) || amount < range[0] || amount > range[1]) {
          res.status(400).json({ error: `قيمة الإعداد "${key}" غير صالحة (يجب أن تكون رقماً بين ${range[0]} و ${range[1]})` });
          return;
        }
      }
      if (key === 'smtp_port' && value.trim() !== '' && !ALLOWED_SMTP_PORTS.includes(Number(value))) {
        res.status(400).json({ error: 'منفذ SMTP غير مسموح. المنافذ المتاحة: 25، 465، 587، 2525' });
        return;
      }
      updates.push([key, value]);
    }

    for (const [key, value] of updates) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [key, value]
      );
    }

    if (updates.length > 0) {
      const before: Record<string, string> = {};
      const after: Record<string, string> = {};
      for (const [key, value] of updates) {
        const secret = SECRET_SETTING_KEYS.includes(key);
        before[key] = secret ? '********' : (existing[key] ?? '');
        after[key] = secret ? '********' : value;
      }
      await logAudit(
        req.user?.email || 'admin',
        'تحديث إعدادات النظام العامة',
        `تم تعديل الإعدادات: ${updates.map(([key]) => key).join('، ')}`,
        req.ip,
        req.user?.email || 'المسؤول',
        before,
        after
      );
    }
    res.json({ success: true, message: 'تم حفظ إعدادات النظام بنجاح' });
  } catch (error: any) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'فشل حفظ إعدادات النظام' });
  }
};

export const testSmtpConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { host, port, user, secure, fromEmail, testEmail, templateSubject, templateHtml, variables } = req.body;
    if (!host || !port || typeof host !== 'string') {
      res.status(400).json({ error: 'يرجى إدخال خادم SMTP والمنفذ على الأقل' });
      return;
    }
    const portNumber = Number(port);
    if (!ALLOWED_SMTP_PORTS.includes(portNumber)) {
      res.status(400).json({ error: 'منفذ SMTP غير مسموح. المنافذ المتاحة: 25، 465، 587، 2525' });
      return;
    }

    // The test connects from the server, so it must not be usable to reach internal addresses
    const cleanHost = host.trim();
    let addresses: { address: string }[] = [];
    try {
      addresses = await dns.promises.lookup(cleanHost, { all: true });
    } catch {
      res.status(400).json({ success: false, error: 'تعذر العثور على خادم SMTP بهذا العنوان' });
      return;
    }
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      res.status(400).json({ success: false, error: 'عنوان خادم SMTP غير مسموح' });
      return;
    }

    // An empty password means the page is testing with the saved one
    let pass = typeof req.body.pass === 'string' ? req.body.pass : '';
    if (!pass) {
      const saved = await pool.query('SELECT value FROM settings WHERE key = $1', ['smtp_pass']);
      pass = saved.rows[0]?.value || '';
    }

    const transporter = nodemailer.createTransport({
      // Connect to the address that was checked, so a second DNS answer cannot point elsewhere
      host: addresses[0].address,
      port: portNumber,
      secure: secure === true || secure === 'true' || portNumber === 465,
      auth: user && pass ? { user, pass } : undefined,
      tls: { servername: cleanHost },
    });

    await transporter.verify();

    if (testEmail) {
      const platformRes = await pool.query('SELECT value FROM settings WHERE key = $1', ['platform_name']);
      const platformName = platformRes.rows[0]?.value || 'سدرة';

      const emailVars = {
        company_name: platformName,
        platform_name: platformName,
        code: '584920',
        verification_code: '584920',
        user_name: 'أحمد محمد',
        support_email: user || fromEmail || 'support@sdra.com',
        ...(variables || {}),
      };

      const subject = templateSubject
        ? replaceEmailPlaceholders(templateSubject, emailVars)
        : `اختبار اتصال خادم البريد - ${platformName}`;

      const html = templateHtml
        ? replaceEmailPlaceholders(templateHtml, emailVars)
        : `<h3>نجح اختبار اتصال SMTP بنجاح!</h3><p>هذه رسالة اختبار مرسلة من لوحة تحكم ${platformName} للتأكد من سلامة إعدادات البريد.</p>`;

      await transporter.sendMail({
        from: fromEmail || user || 'noreply@sdra.com',
        to: testEmail,
        subject,
        html,
      });
    }

    res.json({ success: true, message: 'تم التحقق من اتصال SMTP وإرسال رسالة الاختبار بنجاح' });
  } catch (error: any) {
    console.error('SMTP test error:', error);
    res.status(400).json({ success: false, error: 'فشل الاتصال بخادم SMTP، تحقق من العنوان والمنفذ وبيانات الدخول' });
  }
};

// Only these keys are readable without logging in
const PUBLIC_SETTING_KEYS = [
  'platform_name', 'currency', 'support_email', 'support_phone', 'whatsapp_number', 'website_url', 'company_address',
  'google_login_enabled', 'google_client_id_web', 'google_client_id_android', 'google_client_id_ios',
  'privacy_policy_title', 'privacy_policy_content', 'privacy_policy_status', 'packages_disclaimer_note',
  'about_us_content', 'terms_content', 'support_whatsapp_hours', 'support_email_note',
  'profile_required_fields', 'profile_completion_enforced', 'auth_require_email_verification', 'auth_password_min_length',
];

export const getPublicSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [PUBLIC_SETTING_KEYS]);
    const settingsObj: Record<string, string> = {};
    for (const row of result.rows) {
      settingsObj[row.key] = row.value;
    }
    res.json({ success: true, data: settingsObj });
  } catch (error: any) {
    console.error('Error fetching public settings:', error);
    res.status(500).json({ error: 'فشل جلب الإعدادات العامة' });
  }
};


// ==========================================
// STORE MANAGEMENT ADMIN CONTROLLERS
// ==========================================

// --- 1. STORE CATEGORIES ---
export const adminGetCategories = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Cleanup any duplicates
    await pool.query(`DELETE FROM store_categories a USING store_categories b WHERE a.id > b.id AND a.name = b.name;`).catch(() => {});

    const DEFAULT_CATS = [
      { name: 'ملابس الإحرام', icon: 'shirt-outline', sort_order: 1 },
      { name: 'ملابس النساء', icon: 'woman-outline', sort_order: 2 },
      { name: 'مستلزمات العمرة', icon: 'home-outline', sort_order: 3 },
      { name: 'مستلزمات السفر', icon: 'briefcase-outline', sort_order: 4 },
    ];
    for (const cat of DEFAULT_CATS) {
      await pool.query(
        'INSERT INTO store_categories (id, name, icon, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING',
        [generate16CharId(), cat.name, cat.icon, cat.sort_order]
      );
    }

    const result = await pool.query('SELECT * FROM store_categories ORDER BY sort_order ASC, id ASC');
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل جلب أقسام المتجر' });
  }
};

export const adminCreateCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, icon = 'bag-outline', sort_order = 0, is_active = true } = req.body;
    if (!name) {
      res.status(400).json({ error: 'اسم القسم مطلوب' });
      return;
    }
    const result = await pool.query(
      'INSERT INTO store_categories (id, name, icon, sort_order, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [generate16CharId(), name, icon, parseInt(sort_order, 10) || 0, is_active]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'فشل إنشاء القسم' });
  }
};

export const adminUpdateCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, icon, sort_order, is_active } = req.body;
    const result = await pool.query(
      `UPDATE store_categories
       SET name = COALESCE($1, name),
           icon = COALESCE($2, icon),
           sort_order = COALESCE($3, sort_order),
           is_active = COALESCE($4, is_active)
       WHERE id = $5 RETURNING *`,
      [name, icon, sort_order !== undefined ? parseInt(sort_order, 10) : null, is_active, id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'القسم غير موجود' });
      return;
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل تحديث القسم' });
  }
};

export const adminDeleteCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM store_categories WHERE id = $1', [id]);
    res.json({ success: true, message: 'تم حذف القسم بنجاح' });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل حذف القسم' });
  }
};

// --- 2. STORE PRODUCTS ---
export const adminGetProducts = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name as category_name
       FROM store_products p
       LEFT JOIN store_categories c ON p.category_id = c.id
       ORDER BY p.created_at DESC`
    );
    const products = result.rows.map((p) => ({
      ...p,
      images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : p.images,
      sizes: typeof p.sizes === 'string' ? JSON.parse(p.sizes || '[]') : p.sizes,
      colors: typeof p.colors === 'string' ? JSON.parse(p.colors || '[]') : p.colors,
    }));
    res.json({ success: true, data: products });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل جلب المنتجات' });
  }
};

export const adminCreateProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      custom_id,
      name,
      description,
      price,
      discount_price,
      category_id,
      image_url,
      images = [],
      sizes = [],
      colors = [],
      attributes = {},
      stock = 0,
      is_featured = false,
      is_active = true,
    } = req.body;

    if (!name || !price) {
      res.status(400).json({ error: 'اسم المنتج والسعر مطلوبان' });
      return;
    }

    const generatedCustomId = custom_id?.trim() || `PROD-${Math.floor(1000 + Math.random() * 9000)}`;

    const result = await pool.query(
      `INSERT INTO store_products
       (id, custom_id, name, description, price, discount_price, category_id, image_url, images, sizes, colors, attributes, stock, is_featured, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        generate16CharId(),
        generatedCustomId,
        name,
        description || '',
        price !== undefined && price !== '' && !isNaN(parseFloat(price)) ? parseFloat(price) : 0,
        discount_price !== undefined && discount_price !== '' && !isNaN(parseFloat(discount_price)) ? parseFloat(discount_price) : null,
        category_id ? String(category_id) : null,
        image_url || '',
        JSON.stringify(Array.isArray(images) ? images : []),
        JSON.stringify(Array.isArray(sizes) ? sizes : []),
        JSON.stringify(Array.isArray(colors) ? colors : []),
        typeof attributes === 'object' ? JSON.stringify(attributes) : (attributes || '{}'),
        stock !== undefined && stock !== '' && !isNaN(parseInt(stock, 10)) ? parseInt(stock, 10) : 0,
        is_featured === true || is_featured === 'true',
        is_active === true || is_active === 'true',
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'فشل إنشاء المنتج' });
  }
};

export const adminUpdateProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      custom_id,
      name,
      description,
      price,
      discount_price,
      category_id,
      image_url,
      images,
      sizes,
      colors,
      attributes,
      stock,
      is_featured,
      is_active,
    } = req.body;

    const result = await pool.query(
      `UPDATE store_products
       SET custom_id = COALESCE($1, custom_id),
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           price = COALESCE($4, price),
           discount_price = CASE WHEN $16::boolean THEN $5 ELSE discount_price END,
           category_id = COALESCE($6, category_id),
           image_url = COALESCE($7, image_url),
           images = COALESCE($8, images),
           sizes = COALESCE($9, sizes),
           colors = COALESCE($10, colors),
           attributes = COALESCE($11, attributes),
           stock = COALESCE($12, stock),
           is_featured = COALESCE($13, is_featured),
           is_active = COALESCE($14, is_active)
       WHERE id = $15 RETURNING *`,
      [
        custom_id || null,
        name || null,
        description !== undefined ? description : null,
        price !== undefined && price !== '' && !isNaN(parseFloat(price)) ? parseFloat(price) : null,
        discount_price !== undefined && discount_price !== '' && !isNaN(parseFloat(discount_price)) ? parseFloat(discount_price) : null,
        category_id ? String(category_id) : null,
        image_url || null,
        images !== undefined ? JSON.stringify(Array.isArray(images) ? images : []) : null,
        sizes !== undefined ? JSON.stringify(Array.isArray(sizes) ? sizes : []) : null,
        colors !== undefined ? JSON.stringify(Array.isArray(colors) ? colors : []) : null,
        attributes !== undefined ? (typeof attributes === 'object' ? JSON.stringify(attributes) : attributes) : null,
        stock !== undefined && stock !== '' && !isNaN(parseInt(stock, 10)) ? parseInt(stock, 10) : null,
        is_featured !== undefined ? (is_featured === true || is_featured === 'true') : null,
        is_active !== undefined ? (is_active === true || is_active === 'true') : null,
        id,
        // The discount is only touched when the request sends it; an explicit null or '' removes it
        discount_price !== undefined,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'المنتج غير موجود' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'فشل تحديث المنتج' });
  }
};

export const adminDeleteProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM store_products WHERE id = $1', [id]);
    res.json({ success: true, message: 'تم حذف المنتج بنجاح' });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل حذف المنتج' });
  }
};

// --- 3. STORE BANNERS ---
export const adminGetBanners = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT b.*, p.name as product_name, g.name as governorate_name
       FROM store_banners b
       LEFT JOIN store_products p ON b.product_id = p.id
       LEFT JOIN governorates g ON b.governorate_id = g.id
       ORDER BY b.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل جلب البانرات' });
  }
};

export const adminCreateBanner = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, image_url, product_id, governorate_id, start_date, end_date, start_at, end_at, is_active = true } = req.body;
    if (!title || !image_url) {
      res.status(400).json({ error: 'العنوان ورابط الصورة مطلوبان' });
      return;
    }

    let resolvedProductId = null;
    let resolvedCustomId = null;

    if (product_id) {
      const prodRes = await pool.query(
        'SELECT id, custom_id FROM store_products WHERE id::text = $1 OR custom_id = $1 OR name = $1',
        [product_id.toString()]
      );
      if (prodRes.rows.length > 0) {
        resolvedProductId = prodRes.rows[0].id;
        resolvedCustomId = prodRes.rows[0].custom_id;
      }
    }

    const result = await pool.query(
      `INSERT INTO store_banners (id, title, image_url, product_id, product_custom_id, governorate_id, start_date, end_date, start_at, end_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        generate16CharId(),
        title,
        image_url,
        resolvedProductId,
        resolvedCustomId,
        governorate_id ? String(governorate_id) : null,
        start_date || null,
        end_date || null,
        start_at || null,
        end_at || null,
        is_active === true || is_active === 'true',
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل إنشاء البانر' });
  }
};

export const adminUpdateBanner = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, image_url, product_id, governorate_id, start_date, end_date, start_at, end_at, is_active } = req.body;

    let resolvedProductId = null;
    let resolvedCustomId = null;

    if (product_id) {
      const prodRes = await pool.query(
        'SELECT id, custom_id FROM store_products WHERE id::text = $1 OR custom_id = $1 OR name = $1',
        [product_id.toString()]
      );
      if (prodRes.rows.length > 0) {
        resolvedProductId = prodRes.rows[0].id;
        resolvedCustomId = prodRes.rows[0].custom_id;
      }
    }

    const result = await pool.query(
      `UPDATE store_banners
       SET title = COALESCE($1, title),
           image_url = COALESCE($2, image_url),
           product_id = COALESCE($3, product_id),
           product_custom_id = COALESCE($4, product_custom_id),
           governorate_id = $5,
           start_date = $6,
           end_date = $7,
           start_at = $8,
           end_at = $9,
           is_active = COALESCE($10, is_active)
       WHERE id = $11 RETURNING *`,
      [
        title || null,
        image_url || null,
        resolvedProductId,
        resolvedCustomId,
        governorate_id ? parseInt(governorate_id, 10) : null,
        start_date || null,
        end_date || null,
        start_at || null,
        end_at || null,
        is_active !== undefined ? (is_active === true || is_active === 'true') : null,
        id,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'البانر غير موجود' });
      return;
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل تحديث البانر' });
  }
};

export const adminDeleteBanner = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM store_banners WHERE id = $1', [id]);
    res.json({ success: true, message: 'تم حذف البانر بنجاح' });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل حذف البانر' });
  }
};

// --- 4. STORE ORDERS ---
export const adminGetOrders = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT o.*,
              (SELECT JSON_AGG(i.*) FROM store_order_items i WHERE i.order_id = o.id) as items
       FROM store_orders o
       ORDER BY o.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل جلب طلبات المتجر' });
  }
};

export const adminUpdateOrderStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      res.status(400).json({ error: 'حالة الطلب مطلوبة' });
      return;
    }

    const allowedTransitions: Record<string, string[]> = {
      pending: ['processing', 'cancelled'],
      processing: ['shipped', 'cancelled'],
      shipped: ['delivered'],
      delivered: [],
      cancelled: [],
    };

    // Locked so two admins cannot cancel the same order at once and return its stock twice
    const client = await pool.connect();
    let result: any;
    try {
      await client.query('BEGIN');
      const currentOrder = await client.query('SELECT status FROM store_orders WHERE id = $1 FOR UPDATE', [id]);
      if (currentOrder.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'الطلب غير موجود' });
        return;
      }
      const previousStatus = currentOrder.rows[0].status || 'pending';
      if (status !== previousStatus && !(allowedTransitions[previousStatus] || []).includes(status)) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'لا يمكن نقل الطلب إلى هذه الحالة من حالته الحالية' });
        return;
      }

      // Cancelled orders give their reserved quantities back to the store, once
      if (status === 'cancelled' && previousStatus !== 'cancelled') {
        await client.query(
          `UPDATE store_products p SET stock = p.stock + i.quantity
           FROM (SELECT product_id, SUM(quantity)::int AS quantity FROM store_order_items WHERE order_id = $1 GROUP BY product_id) i
           WHERE i.product_id = p.id`,
          [id]
        );
      }

      result = await client.query(
        `UPDATE store_orders
         SET status = $1, updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [status, id]
      );
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK').catch(() => {});
      throw txError;
    } finally {
      client.release();
    }

    const order = result.rows[0];

    // Once the order leaves "pending" an admin has taken it in hand
    if (status !== 'pending') await resolveAdminAlerts('store_order', String(order.id), req.user?.email || null);

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'تحديث حالة طلب المتجر',
      `تحديث حالة الطلب #${order.order_number} إلى (${status})`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      JSON.stringify({ status, orderId: order.id, orderNumber: order.order_number })
    );

    // Send notification to user if linked
    if (order.user_id) {
      const statusNames: Record<string, string> = {
        processing: 'جاري تجهيز الطلب',
        shipped: 'تم شحن الطلب',
        delivered: 'تم توصيل الطلب بنجاح',
        cancelled: 'تم إلغاء الطلب',
      };
      const statusTitle = statusNames[status] || 'تحديث حالة الطلب';
      await createAndSendNotification({
        userId: order.user_id,
        title: statusTitle,
        subtitle: `تم تغيير حالة طلبك رقم #${order.order_number} إلى: ${statusNames[status] || status}`,
        category: 'store',
        icon: 'bag-handle-outline',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        data: { type: 'order_status', status, orderNumber: order.order_number, orderId: order.id },
      });
    }

    res.json({ success: true, message: 'تم تحديث حالة الطلب بنجاح', data: order });
  } catch (error: any) {
    res.status(500).json({ error: 'فشل تحديث حالة الطلب' });
  }
};

// ─── Notification Templates Management (إدارة قوالب الإشعارات) ──────────────────────

export const getNotificationTemplates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { system } = req.query;
    let query = 'SELECT * FROM notification_templates';
    const params: any[] = [];
    if (system && typeof system === 'string' && system !== 'all') {
      query += ' WHERE system = $1';
      params.push(system);
    }
    query += ' ORDER BY created_at ASC';

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching notification templates:', error);
    res.status(500).json({ error: 'فشل جلب قوالب الإشعارات' });
  }
};

export const createNotificationTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      system,
      status_key,
      name,
      title,
      subtitle,
      category,
      icon,
      icon_bg,
      icon_color,
      variables,
      is_active,
    } = req.body;

    if (!system || !status_key || !name || !title || !subtitle) {
      res.status(400).json({ error: 'النظام وكود الحالة والاسم وعنوان الإشعار ومحتواه حقول مطلوبة' });
      return;
    }

    const cleanStatusKey = String(status_key).trim().toLowerCase().replace(/\s+/g, '_');

    const existing = await pool.query(
      'SELECT id FROM notification_templates WHERE system = $1 AND status_key = $2',
      [system, cleanStatusKey]
    );
    if (existing.rows.length > 0) {
      res.status(400).json({ error: `يوجد قالب مسجل بالفعل لنظام "${system}" بالحالة "${cleanStatusKey}"` });
      return;
    }

    const result = await pool.query(
      `INSERT INTO notification_templates (
        id, system, status_key, name, title, subtitle, category, icon, icon_bg, icon_color, variables, is_active, is_system
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false)
      RETURNING *`,
      [
        generate16CharId(),
        system,
        cleanStatusKey,
        name,
        title,
        subtitle,
        category || 'عام',
        icon || 'notifications-outline',
        icon_bg || '#EFF6FF',
        icon_color || '#2563EB',
        Array.isArray(variables) ? variables : [],
        is_active !== false,
      ]
    );

    await logAudit(
      req.user?.email || 'admin',
      'إضافة قالب إشعار جديد',
      `تمت إضافة قالب إشعار جديد بعنوان "${title}" للنظام "${system}"`,
      req.ip
    );

    res.status(201).json({ success: true, message: 'تم إنشاء القالب بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating notification template:', error);
    res.status(500).json({ error: 'فشل إنشاء قالب الإشعار' });
  }
};

export const updateNotificationTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      name,
      title,
      subtitle,
      category,
      icon,
      icon_bg,
      icon_color,
      variables,
      is_active,
      status_key,
    } = req.body;

    const existingRes = await pool.query('SELECT * FROM notification_templates WHERE id = $1', [id]);
    if (existingRes.rows.length === 0) {
      res.status(404).json({ error: 'القالب غير موجود' });
      return;
    }

    const result = await pool.query(
      `UPDATE notification_templates
       SET name = COALESCE($1, name),
           title = COALESCE($2, title),
           subtitle = COALESCE($3, subtitle),
           category = COALESCE($4, category),
           icon = COALESCE($5, icon),
           icon_bg = COALESCE($6, icon_bg),
           icon_color = COALESCE($7, icon_color),
           variables = COALESCE($8, variables),
           is_active = COALESCE($9, is_active),
           status_key = COALESCE($10, status_key),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *`,
      [
        name ?? null,
        title ?? null,
        subtitle ?? null,
        category ?? null,
        icon ?? null,
        icon_bg ?? null,
        icon_color ?? null,
        Array.isArray(variables) ? variables : null,
        typeof is_active === 'boolean' ? is_active : null,
        status_key ? String(status_key).trim().toLowerCase().replace(/\s+/g, '_') : null,
        id,
      ]
    );

    await logAudit(
      req.user?.email || 'admin',
      'تعديل قالب إشعار',
      `تم تعديل قالب الإشعار "${result.rows[0].name}" (ID: ${id})`,
      req.ip
    );

    res.json({ success: true, message: 'تم تحديث القالب بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating notification template:', error);
    res.status(500).json({ error: 'فشل تحديث قالب الإشعار' });
  }
};

export const deleteNotificationTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM notification_templates WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'القالب غير موجود' });
      return;
    }

    await pool.query('DELETE FROM notification_templates WHERE id = $1', [id]);

    await logAudit(
      req.user?.email || 'admin',
      'حذف قالب إشعار',
      `تم حذف قالب الإشعار "${existing.rows[0].name}"`,
      req.ip
    );

    res.json({ success: true, message: 'تم حذف القالب بنجاح' });
  } catch (error: any) {
    console.error('Error deleting notification template:', error);
    res.status(500).json({ error: 'فشل حذف قالب الإشعار' });
  }
};

export const resetNotificationTemplates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await pool.query('DELETE FROM notification_templates');
    
    const defaultTemplates = [
      // الحجوزات ومراحل التنفيذ (Bookings & Stages)
      { system: 'bookings', status_key: 'new', name: 'طلب حجز جديد', title: 'طلب حجز جديد #{booking_number}', subtitle: 'مرحباً {customer_name}، تم استلام طلب حجزك بنجاح وجاري مراجعته وتأكيده من قبل إدارة سدرة.', category: 'bookings', icon: 'calendar-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{booking_number}', '{package_name}'] },
      { system: 'bookings', status_key: 'confirmed', name: 'تأكيد الحجز', title: 'تم تأكيد حجزك بنجاح 🎉', subtitle: 'مرحباً {customer_name}، تم تأكيد حجزك رقم #{booking_number} لرحلة {package_name}. يمكنك متابعة برنامج رحلتك عبر التطبيق.', category: 'bookings', icon: 'checkmark-circle-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{booking_number}', '{package_name}', '{company_name}'] },
      { system: 'bookings', status_key: 'receipt_review', name: 'مراجعة إيصال السداد', title: 'جاري مراجعة إيصال السداد', subtitle: 'تم استلام إيصال السداد لحجزك #{booking_number} وجاري التحقق منه من قبل فريق الحسابات.', category: 'payments', icon: 'receipt-outline', icon_bg: '#FEF3C7', icon_color: '#D97706', variables: ['{customer_name}', '{booking_number}'] },
      { system: 'bookings', status_key: 'receipt_rejected', name: 'رفض إيصال السداد', title: 'تنبيه بشأن إيصال السداد ⚠️', subtitle: 'تعذر اعتماد إيصال التحويل المرفق للحجز #{booking_number}. يرجى إعادة رفع إيصال واضح وصحيح عبر التطبيق.', category: 'payments', icon: 'alert-circle-outline', icon_bg: '#FEE2E2', icon_color: '#DC2626', variables: ['{customer_name}', '{booking_number}'] },
      { system: 'bookings', status_key: 'completed', name: 'اكتمال الرحلة والحجز', title: 'اكتملت رحلتك، حمداً لله على سلامتكم ✨', subtitle: 'مرحباً {customer_name}، نتمنى أن تكون رحلتك ممتعة ومباركة! نسعد دائماً بتقييم تجربتك عبر التطبيق.', category: 'bookings', icon: 'sparkles-outline', icon_bg: '#F3E8FF', icon_color: '#9333EA', variables: ['{customer_name}', '{booking_number}', '{package_name}'] },
      { system: 'bookings', status_key: 'cancelled', name: 'إلغاء الحجز', title: 'تم إلغاء الحجز #{booking_number}', subtitle: 'نود إفادتك بأنه تم إلغاء حجزك #{booking_number}. إذا كان لديك أي استفسار يرجى التواصل مع الدعم الفني.', category: 'bookings', icon: 'close-circle-outline', icon_bg: '#FEE2E2', icon_color: '#DC2626', variables: ['{customer_name}', '{booking_number}'] },
      { system: 'bookings', status_key: 'stage_started', name: 'بدء مرحلة جديدة من الرحلة', title: 'مرحلة جديدة: {stage_title} 📍', subtitle: 'بدأت الآن مرحلة "{stage_title}" ضمن جدول رحلتك. يمكنك متابعة خطوات المسار ومواعيد التجمع عبر التطبيق.', category: 'bookings', icon: 'navigate-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{booking_number}', '{stage_title}', '{stage_order}'] },
      { system: 'bookings', status_key: 'stage_completed', name: 'اكتمال مرحلة من الرحلة', title: 'اكتملت مرحلة: {stage_title} ✅', subtitle: 'تم إنجاز مرحلة "{stage_title}" بنجاح. استعد للخطوة القادمة في برنامج رحلتك.', category: 'bookings', icon: 'checkmark-done-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{booking_number}', '{stage_title}'] },
      { system: 'bookings', status_key: 'trip_departed', name: 'انطلاق الرحلة', title: 'انطلقت الرحلة الآن 🚌', subtitle: 'انطلقت رحلتك الآن متوجهة إلى {destination}. نتمنى لكم رحلة آمنة وسعيدة.', category: 'bookings', icon: 'bus-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{booking_number}', '{destination}'] },

      // المتجر والطلبات (Store Orders)
      { system: 'store', status_key: 'order_created', name: 'طلب متجر جديد', title: 'تم استلام طلبك بنجاح 🛍️', subtitle: 'مرحباً {customer_name}، تم استلام طلبك رقم #{order_number} بنجاح وجاري مراجعته وتجهيزه.', category: 'store', icon: 'bag-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{order_number}', '{total_amount}'] },
      { system: 'store', status_key: 'processing', name: 'جاري تجهيز الطلب', title: 'جاري تجهيز طلبك 📦', subtitle: 'بدأ فريق المستودع في تجهيز وتغليف محتويات طلبك رقم #{order_number}.', category: 'store', icon: 'cube-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{order_number}'] },
      { system: 'store', status_key: 'shipped', name: 'تم شحن الطلب', title: 'طلبك في الطريق إليك 🚚', subtitle: 'تم تسليم طلبك رقم #{order_number} لمندوب التوصيل وبات في طريقه لعنوانك.', category: 'store', icon: 'car-outline', icon_bg: '#FEF3C7', icon_color: '#D97706', variables: ['{customer_name}', '{order_number}'] },
      { system: 'store', status_key: 'delivered', name: 'تم توصيل الطلب بنجاح', title: 'تم توصيل طلبك بنجاح ✨', subtitle: 'تم تسليم طلبك رقم #{order_number} بنجاح. شكراً لتسوقك من متجر سدرة، نتمنى أن تنال المنتجات رضاك!', category: 'store', icon: 'gift-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{order_number}'] },
      { system: 'store', status_key: 'cancelled', name: 'إلغاء طلب المتجر', title: 'تم إلغاء الطلب رقم #{order_number}', subtitle: 'تم إلغاء طلبك من المتجر رقم #{order_number}. لأي استفسار لا تتردد بالتواصل مع خدمة العملاء.', category: 'store', icon: 'close-outline', icon_bg: '#FEE2E2', icon_color: '#DC2626', variables: ['{customer_name}', '{order_number}'] },

      // الرسائل والمحادثات (Chats)
      { system: 'chats', status_key: 'new_message', name: 'رسالة محادثة جديدة', title: 'رسالة جديدة من {sender_name} 💬', subtitle: 'لديك رسالة جديدة في المحادثة: "{message_preview}"', category: 'chats', icon: 'chatbubbles-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{sender_name}', '{message_preview}', '{chat_id}'] },
      { system: 'chats', status_key: 'chat_assigned', name: 'تولي ممثل الدعم للمحادثة', title: 'انضم ممثل الدعم للمحادثة 👨‍💼', subtitle: 'الممثل {agent_name} انضم للمحادثة الآن ومستعد لخدمتك والإجابة على كافة استفساراتك.', category: 'chats', icon: 'person-add-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{agent_name}', '{chat_id}'] },
      { system: 'chats', status_key: 'chat_closed', name: 'إغلاق المحادثة', title: 'تم إغلاق المحادثة', subtitle: 'تم إنهاء جلسة المحادثة. شكراً لتواصلك معنا ويسعدنا دائماً تقديم المساعدة.', category: 'chats', icon: 'chatbox-ellipses-outline', icon_bg: '#F1F5F9', icon_color: '#64748B', variables: ['{customer_name}', '{chat_id}'] },

      // التذاكر والدعم الفني (Tickets)
      { system: 'tickets', status_key: 'new_ticket', name: 'فتح تذكرة دعم فني جديدة', title: 'تم فتح التذكرة رقم #{ticket_number} 🎫', subtitle: 'مرحباً {customer_name}، تم استلام تذكرتك "{ticket_subject}" وسيقوم فريق الدعم بالرد عليها في أقرب وقت.', category: 'tickets', icon: 'ticket-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{ticket_number}', '{ticket_subject}'] },
      { system: 'tickets', status_key: 'ticket_reply', name: 'رد جديد على تذكرة الدعم', title: 'رد جديد على تذكرتك #{ticket_number} ✍️', subtitle: 'أضاف فريق الدعم رداً جديداً على تذكرتك: "{reply_preview}". اضغط لعرض التفاصيل.', category: 'tickets', icon: 'mail-unread-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{ticket_number}', '{reply_preview}'] },
      { system: 'tickets', status_key: 'ticket_in_progress', name: 'التذكرة قيد المعالجة', title: 'تذكرتك قيد المعالجة الآن ⚙️', subtitle: 'جاري العمل ومتابعة طلبك في التذكرة رقم #{ticket_number} للوصول إلى أفضل حل.', category: 'tickets', icon: 'time-outline', icon_bg: '#FEF3C7', icon_color: '#D97706', variables: ['{customer_name}', '{ticket_number}'] },
      { system: 'tickets', status_key: 'ticket_resolved', name: 'تم حل التذكرة بنجاح', title: 'تم حل تذكرتك رقم #{ticket_number} ✅', subtitle: 'تمت معالجة المشكلة بنجاح في التذكرة #{ticket_number}. يرجى تأكيد إغلاقها أو تقييم الدعم.', category: 'tickets', icon: 'checkmark-circle-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{ticket_number}'] },
      { system: 'tickets', status_key: 'ticket_closed', name: 'إغلاق تذكرة الدعم', title: 'تم إغلاق التذكرة #{ticket_number}', subtitle: 'تم إغلاق تذكرة الدعم #{ticket_number}. نتمنى أن تكون الخدمة نالت إعجابك، ونسعد بتواصلك مجدداً.', category: 'tickets', icon: 'lock-closed-outline', icon_bg: '#F1F5F9', icon_color: '#64748B', variables: ['{customer_name}', '{ticket_number}'] }
    ];

    for (const tpl of defaultTemplates) {
      await pool.query(
        `INSERT INTO notification_templates (id, system, status_key, name, title, subtitle, category, icon, icon_bg, icon_color, variables, is_active, is_system)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, true)
         ON CONFLICT (system, status_key) DO UPDATE SET
           name = EXCLUDED.name,
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           category = EXCLUDED.category,
           icon = EXCLUDED.icon,
           icon_bg = EXCLUDED.icon_bg,
           icon_color = EXCLUDED.icon_color,
           variables = EXCLUDED.variables,
           is_active = true,
           updated_at = CURRENT_TIMESTAMP`,
        [generate16CharId(), tpl.system, tpl.status_key, tpl.name, tpl.title, tpl.subtitle, tpl.category, tpl.icon, tpl.icon_bg, tpl.icon_color, tpl.variables]
      );
    }

    const all = await pool.query('SELECT * FROM notification_templates ORDER BY created_at ASC');

    await logAudit(
      req.user?.email || 'admin',
      'استعادة قوالب الإشعارات الافتراضية',
      'تمت إعادة ضبط جميع قوالب الإشعارات إلى حالتها القياسية الافتراضية',
      req.ip
    );

    res.json({ success: true, message: 'تم استعادة القوالب الافتراضية بنجاح', data: all.rows });
  } catch (error: any) {
    console.error('Error resetting notification templates:', error);
    res.status(500).json({ error: 'فشل استعادة القوالب الافتراضية' });
  }
};

export const getPlatformEarnings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const totalEarningsRes = await pool.query(
      `SELECT COALESCE(SUM(commission_amount), 0) as total_earnings FROM platform_earnings WHERE status = 'recorded'`
    );
    const totalEarnings = parseFloat(totalEarningsRes.rows[0].total_earnings || 0);

    const statsRes = await pool.query(`
      SELECT
        COUNT(*) as total_bookings,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_bookings,
        COUNT(*) FILTER (WHERE status = 'confirmed' OR status = 'receipt_review' OR status = 'pending') as ongoing_bookings,
        COUNT(*) FILTER (WHERE receipt_approved = TRUE) as approved_receipts
      FROM bookings
    `);
    const stats = statsRes.rows[0];

    const companyEarningsRes = await pool.query(`
      SELECT c.id, c.name, c.logo_url, c.public_id,
             COALESCE(pe.total_earnings, 0) as total_earnings,
             COALESCE(b_count.bookings_count, 0) as bookings_count
      FROM companies c
      LEFT JOIN (
        SELECT company_id, SUM(commission_amount) as total_earnings
        FROM platform_earnings
        WHERE status = 'recorded'
        GROUP BY company_id
      ) pe ON c.id = pe.company_id
      LEFT JOIN (
        SELECT p.company_id, COUNT(b.id) as bookings_count
        FROM bookings b
        JOIN packages p ON b.package_id = p.id
        GROUP BY p.company_id
      ) b_count ON c.id = b_count.company_id
      ORDER BY total_earnings DESC
    `);

    res.json({
      success: true,
      data: {
        totalEarnings,
        totalBookings: parseInt(stats.total_bookings || 0, 10),
        completedBookings: parseInt(stats.completed_bookings || 0, 10),
        ongoingBookings: parseInt(stats.ongoing_bookings || 0, 10),
        approvedReceipts: parseInt(stats.approved_receipts || 0, 10),
        companyEarnings: companyEarningsRes.rows.map(row => ({
          ...row,
          id: formatCompanyId(row.id, row.public_id),
          total_earnings: parseFloat(row.total_earnings || 0),
          bookings_count: parseInt(row.bookings_count || 0, 10)
        }))
      }
    });
  } catch (error: any) {
    console.error('Error fetching platform earnings:', error);
    res.status(500).json({ error: 'فشل جلب أرباح المنصة' });
  }
};
