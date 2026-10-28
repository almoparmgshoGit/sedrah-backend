import { Response, Request } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { formatUserId, formatCompanyId, generateRandomToken, generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import argon2 from 'argon2';
import nodemailer from 'nodemailer';
import { replaceEmailPlaceholders } from '../utils/mailer';
import { createAndSendNotification } from '../utils/notificationHelper';

const resolveUserId = async (param: string | number) => {
  const str = String(param);
  const res = await pool.query('SELECT id FROM users WHERE id = $1', [str]);
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
        phone: user.phone || 'غير متوفر',
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
          country: user.country || 'المملكة العربية السعودية',
          city: user.city || 'الرياض',
          status: user.status || 'active',
          createdAt: user.created_at,
        },
        bookings: bookingsRes.rows,
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

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'البريد الإلكتروني مسجل مسبقاً' });
      return;
    }

    const passwordHash = await argon2.hash(password || 'Password123!');
    const publicId = generateRandomToken('usr');
    const permsStr = Array.isArray(permissions) ? JSON.stringify(permissions) : JSON.stringify([]);

    let parsedGroupId: number | null = null;
    if (permission_group_id) {
      const num = parseInt(String(permission_group_id), 10);
      if (!isNaN(num)) parsedGroupId = num;
    }

    const newUserId = generateRandomToken('usr');
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, phone, role, status, permissions, permission_group_id, public_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9)
       RETURNING id, name, email, phone, role, status, permissions, permission_group_id, created_at, public_id`,
      [newUserId, name, email, passwordHash, phone || null, role || 'user', permsStr, parsedGroupId, publicId]
    );

    const newUser = result.rows[0];

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'إنشاء مستخدم جديد',
      `تم إنشاء مستخدم جديد "${newUser.name}" (${newUser.email}) - الدور: ${newUser.role}`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      newUser
    );

    res.status(201).json({
      success: true,
      message: 'تم إنشاء المستخدم بنجاح',
      data: {
        id: newUser.public_id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        permission_group_id: newUser.permission_group_id,
        createdAt: newUser.created_at,
        status: newUser.status,
        permissions: Array.isArray(permissions) ? permissions : []
      }
    });
  } catch (error: any) {
    console.error('Error creating user by admin:', error);
    res.status(500).json({ error: 'فشل إنشاء المستخدم' });
  }
};

export const updateUserByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const { name, email, phone, role, country, city, permissions, permission_group_id } = req.body;
    const permsStr = permissions ? (Array.isArray(permissions) ? JSON.stringify(permissions) : String(permissions)) : null;

    let parsedGroupId: number | null = null;
    if (permission_group_id !== undefined && permission_group_id !== null && permission_group_id !== '') {
      const num = parseInt(String(permission_group_id), 10);
      if (!isNaN(num)) parsedGroupId = num;
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
         permission_group_id = CASE WHEN $8::boolean THEN $9::integer ELSE permission_group_id END
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
    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'تحديث بيانات مستخدم',
      `تم تحديث بيانات المستخدم "${updatedUser.name}" (${updatedUser.email})`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      updatedUser
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

    const newStatus = status || 'banned';
    await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      [newStatus, internalUserId]
    );

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

export const createCompanyForUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    const { name, cityId, description, logoUrl, bannerUrl } = req.body;

    if (!name) {
      res.status(400).json({ error: 'اسم الشركة مطلوب' });
      return;
    }

    // Resolve a valid city_id to avoid foreign key constraint violations
    let targetCityId = parseInt(cityId, 10);
    if (isNaN(targetCityId)) {
      targetCityId = 1;
    }

    const cityCheck = await pool.query('SELECT id FROM cities WHERE id = $1', [targetCityId]);
    if (cityCheck.rows.length === 0) {
      const firstCityRes = await pool.query('SELECT id FROM cities ORDER BY id ASC LIMIT 1');
      if (firstCityRes.rows.length > 0) {
        targetCityId = firstCityRes.rows[0].id;
      } else {
        const newCityRes = await pool.query(
          `INSERT INTO cities (id, name, image_url, total_companies, total_packages, description)
           VALUES ($1, 'القاهرة', '', 0, 0, 'العاصمة') RETURNING id`,
          [generateRandomToken('cty')]
        );
        targetCityId = newCityRes.rows[0].id;
      }
    }

    const publicId = generateRandomToken('cmp');
    const newCompanyId = generateRandomToken('cmp');
    const result = await pool.query(
      `INSERT INTO companies (id, user_id, city_id, name, logo_url, banner_url, description, rating, reviews_count, verified, public_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0.0, 0, true, $8)
       RETURNING *`,
      [newCompanyId, internalUserId, targetCityId, name, logoUrl || '', bannerUrl || '', description || 'شركة سياحية مرخصة', publicId]
    );

    const newCompany = result.rows[0];

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'فتح وربط شركة جديدة',
      `تم إنشاء وربط الشركة "${newCompany.name}" للمستخدم رقم ${internalUserId}`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      newCompany
    );

    res.status(201).json({
      success: true,
      message: 'تم فتح وربط الشركة للمستخدم بنجاح',
      data: newCompany,
    });
  } catch (error: any) {
    console.error('Error creating company for user:', error);
    res.status(500).json({ error: 'فشل فتح الشركة للمستخدم' });
  }
};

export const deleteUserByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const internalUserId = await resolveUserId(String(req.params.id));
    if (!internalUserId) {
      res.status(404).json({ error: 'المستخدم غير موجود' });
      return;
    }

    await pool.query('DELETE FROM users WHERE id = $1', [internalUserId]);

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
      WHERE b.status != 'cancelled' AND b.status != 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id AND ts.status != 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id
      )
    `);
    const result = await pool.query(`
      SELECT b.*, u.name as customer_name, p.title as package_title, c.name as company_name
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

export const updateBookingStatusByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, cancellation_reason, cancelled_by, appointment_date, appointment_time, appointment_status } = req.body;
    const result = await pool.query(
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
        status ? String(status) : null,
        id,
        cancellation_reason || null,
        cancelled_by || 'admin',
        appointment_date || null,
        appointment_time || null,
        appointment_status || null,
      ]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الحجز غير موجود' });
      return;
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
      cancelled: 'ملغي'
    };
    const notifBody = `تم تحديث حالة حجزك رقم #${booking.booking_reference} إلى: ${statusLabels[status] || status}`;
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

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'تحديث حالة الحجز',
      `تم تحديث حالة الحجز رقم #${booking.booking_reference} إلى (${status})`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      booking
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

    const result = await pool.query(
      `UPDATE trip_stages
       SET status = COALESCE($1, status),
           traveler_name = COALESCE($2, traveler_name),
           document_url = COALESCE($3, document_url),
           document_number = COALESCE($4, document_number),
           details = COALESCE($5, details)
       WHERE id = $6 AND booking_id = $7 RETURNING *`,
      [status, traveler_name, document_url, document_number, details, stageId, id]
    );

    // If stage is cancelled (or stage 1 cancelled), auto-cancel the entire booking!
    if (status === 'cancelled') {
      const cancelReason = details || `تم إلغاء مرحلة "${targetStage.title}" وبناءً عليه تم إلغاء الحجز بالكامل من الإدارة`;
      await pool.query(
        `UPDATE bookings
         SET status = 'cancelled',
             cancellation_reason = $1,
             cancelled_by = 'admin'
         WHERE id = $2`,
        [cancelReason, id]
      );

      // Set all stages for this booking to 'cancelled'
      await pool.query(
        `UPDATE trip_stages
         SET status = 'cancelled'
         WHERE booking_id = $1`,
        [id]
      );
    }

    // Auto-update booking status to completed if all stages are completed
    await pool.query(`
      UPDATE bookings b
      SET status = 'completed'
      WHERE b.id = $1 AND b.status != 'cancelled'
      AND NOT EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id AND ts.status != 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id
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

      const notifBody = `حجزك #${booking.booking_reference}: تم تحديث مرحلة "${targetStage.title}" إلى (${stageStatusLabels[status] || status})${extraInfo}`;
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
    const result = await pool.query('SELECT * FROM companies ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'فشل جلب الشركات' });
  }
};

export const getAllCities = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.image_url,
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
      ORDER BY c.id ASC
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

    await pool.query(`
      UPDATE companies
      SET reviews_count = (SELECT COUNT(*) FROM reviews WHERE company_id = $1),
          rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE company_id = $1), 0.0)
      WHERE id = $1
    `, [rev.company_id]);

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

    await logAudit(req.user?.email || 'admin', newHidden ? 'إخفاء تقييم' : 'إظهار تقييم', `تم ${newHidden ? 'إخفاء' : 'إظهار'} التقييم برقم ${id} مؤقتاً`, req.ip, req.user?.email || 'المسؤول');
    res.json({ success: true, message: newHidden ? 'تم إخفاء التقييم مؤقتاً' : 'تم إظهار التقييم بنجاح', data: rev });
  } catch (error: any) {
    console.error('Error toggling review visibility:', error);
    res.status(500).json({ error: 'فشل تغيير حالة إخفاء التقييم' });
  }
};

export const getAuditLogs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO audit_logs (id, admin_email, admin_name, action, details, ip_address, before_data, after_data)
         VALUES ($1, 'admin@sdra.com', 'مالك النظام', 'تهيئة نظام التدقيق', 'تم تفعيل نظام تسجيل النشاط والأمان بنجاح', '127.0.0.1', $2, $3)`,
        [generate16CharId(), JSON.stringify({ status: 'initializing' }), JSON.stringify({ status: 'active' })]
      );
      result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
    }
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'فشل جلب سجلات التدقيق والأمان' });
  }
};

export const getSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM settings ORDER BY key ASC');
    const settingsObj: Record<string, string> = {};
    for (const row of result.rows) {
      settingsObj[row.key] = row.value;
    }
    res.json({ success: true, data: settingsObj });
  } catch (error: any) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'فشل جلب إعدادات النظام' });
  }
};

export const updateSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settingsMap = req.body;
    for (const key of Object.keys(settingsMap)) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [key, String(settingsMap[key])]
      );
    }
    await logAudit(req.user?.email || 'admin', 'تحديث إعدادات النظام العامة', 'تم حفظ التغييرات على إعدادات المنصة', req.ip);
    res.json({ success: true, message: 'تم حفظ إعدادات النظام بنجاح' });
  } catch (error: any) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'فشل حفظ إعدادات النظام' });
  }
};

export const testSmtpConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { host, port, user, pass, secure, fromEmail, testEmail, templateSubject, templateHtml, variables } = req.body;
    if (!host || !port) {
      res.status(400).json({ error: 'يرجى إدخال خادم SMTP والمنفذ على الأقل' });
      return;
    }

    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: secure === true || secure === 'true' || Number(port) === 465,
      auth: user && pass ? { user, pass } : undefined,
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
    res.status(400).json({ success: false, error: `فشل الاتصال بخادم SMTP: ${error.message}` });
  }
};

export const getPublicSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT key, value FROM settings WHERE key NOT LIKE \'%smtp_pass%\' AND key NOT LIKE \'%secret%\'');
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

export const reviewBookingReceiptByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { action, rejectionReason, allowRetry, retryCount } = req.body; // action: 'approve' | 'reject'

    if (action === 'approve' || action === 'approved') {
      const result = await pool.query(
        `UPDATE bookings
         SET status = 'confirmed',
             receipt_approved = TRUE,
             receipt_status = 'approved',
             rejection_reason = NULL
         WHERE id = $1
         RETURNING *`,
        [id]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'الحجز غير موجود' });
        return;
      }
      const booking = result.rows[0];

      // Mark stage 2 ("بانتظار مراجعة إيصال الدفع") as completed
      await pool.query(
        `UPDATE trip_stages
         SET status = 'completed'
         WHERE booking_id = $1 AND (stage_order = 2 OR title LIKE '%إيصال%')`,
        [booking.id]
      );

      // Advance stage 3 to 'current' if pending
      await pool.query(
        `UPDATE trip_stages
         SET status = 'current'
         WHERE booking_id = $1 AND stage_order = 3 AND status = 'pending'`,
        [booking.id]
      );

      await createAndSendNotification({
        userId: booking.user_id,
        title: 'تم اعتماد إيصال الدفع',
        subtitle: `تمت الموافقة على إيصال الدفع لحجزك #${booking.booking_reference} وتأكيد الحجز بنجاح.`,
        category: 'booking',
        icon: 'checkmark-circle-outline',
        iconBg: '#ECFDF5',
        iconColor: '#059669',
        data: { type: 'receipt_approved', bookingRef: booking.booking_reference },
      });

      res.json({ success: true, message: 'تم اعتماد الإيصال وتأكيد الحجز وتحديث مرحلة الإيصال إلى مكتمل بنجاح', data: booking });
      return;
    } else if (action === 'reject') {
      const isRetryAllowed = allowRetry !== false && allowRetry !== 'false';
      const newStatus = isRetryAllowed ? 'receipt_review' : 'cancelled';

      const result = await pool.query(
        `UPDATE bookings
         SET status = $1,
             receipt_approved = FALSE,
             receipt_status = 'rejected',
             rejection_reason = $2,
             allow_retry = $3,
             retry_count = COALESCE($4, retry_count)
         WHERE id = $5
         RETURNING *`,
        [newStatus, rejectionReason || 'تم رفض الإيصال من الإدارة', isRetryAllowed, retryCount !== undefined ? parseInt(retryCount, 10) : null, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'الحجز غير موجود' });
        return;
      }
      const booking = result.rows[0];

      // Reset stage 2 and subsequent stages
      await pool.query(
        `UPDATE trip_stages
         SET status = CASE WHEN stage_order = 2 THEN 'current' ELSE 'pending' END
         WHERE booking_id = $1 AND stage_order >= 2`,
        [booking.id]
      );

      const notifSub = isRetryAllowed
        ? `تم رفض إيصال الدفع لحجزك #${booking.booking_reference}. السبب: ${rejectionReason || 'يرجى مراجعة الملاحظة وإعادة الرفع'}`
        : `تم رفض إيصال الدفع وإغلاق الحجز #${booking.booking_reference}. السبب: ${rejectionReason || 'الإيصال غير مطابق'}`;

      await createAndSendNotification({
        userId: booking.user_id,
        title: 'رفض إيصال الدفع',
        subtitle: notifSub,
        category: 'booking',
        icon: 'alert-circle-outline',
        iconBg: '#FEF2F2',
        iconColor: '#DC2626',
        data: { type: 'receipt_rejected', bookingRef: booking.booking_reference, reason: rejectionReason },
      });

      res.json({ success: true, message: 'تم رفض الإيصال وتحديث حالة الحجز والمراحل', data: booking });
      return;
    } else if (action === 'pending' || action === 'review') {
      const result = await pool.query(
        `UPDATE bookings
         SET status = 'receipt_review',
             receipt_approved = FALSE,
             receipt_status = 'pending',
             rejection_reason = NULL
         WHERE id = $1
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'الحجز غير موجود' });
        return;
      }
      const booking = result.rows[0];

      // Reset stage 2 to 'current' and subsequent stages to 'pending'
      await pool.query(
        `UPDATE trip_stages
         SET status = CASE WHEN stage_order = 2 THEN 'current' ELSE 'pending' END
         WHERE booking_id = $1 AND stage_order >= 2`,
        [booking.id]
      );

      res.json({ success: true, message: 'تم إعادة حالة الإيصال إلى قيد المراجعة', data: booking });
      return;
    }

    res.status(400).json({ error: 'إجراء غير معروف' });
  } catch (error: any) {
    console.error('Error reviewing receipt:', error);
    res.status(500).json({ error: 'فشل مراجعة الإيصال' });
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
    res.status(500).json({ error: error.message || 'فشل إنشاء القسم' });
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
       ORDER BY p.id DESC`
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
    res.status(500).json({ error: error.message || 'فشل إنشاء المنتج' });
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
           discount_price = $5,
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
       ORDER BY b.id DESC`
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
       ORDER BY o.id DESC`
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

    const result = await pool.query(
      `UPDATE store_orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الطلب غير موجود' });
      return;
    }

    const order = result.rows[0];

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
    query += ' ORDER BY id ASC';

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

    const all = await pool.query('SELECT * FROM notification_templates ORDER BY id ASC');

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
