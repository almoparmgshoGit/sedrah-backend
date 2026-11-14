import { isCompanySuspended, suspensionInfo, SUSPENDED_ERROR } from '../utils/companySuspension';
import { Response, NextFunction } from 'express';
import { pool } from '../config/db';
import { io } from '../server';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId } from '../utils/formatId';
import { createAndSendNotification } from '../utils/notificationHelper';
import { logAudit } from '../utils/auditLogger';
import { normalizeUploadUrl, resolveUserUpload } from '../utils/uploadAccess';
import { getCompanyReadiness } from '../utils/companyReadiness';
import { createAdminAlert } from '../utils/adminAlerts';
import { updateBookingStatusByAdmin, type BookingStatusRequest } from './admin.controller';
import {
  CompanyAccess,
  COMPANY_PERMISSION_GROUPS,
  logCompanyActivity,
  notifyCompanyTeam,
  resolveCompanyAccess,
} from '../utils/companyAccess';
import { expireOverdueAppointmentsThrottled, isPastAppointmentTime, localToday, markAppointmentAttended } from '../utils/appointmentLifecycle';

export interface CompanyRequest extends AuthRequest {
  company?: any;
  booking?: any;
  access?: CompanyAccess;
  actor?: { id: string; name: string };
}

const param = (req: AuthRequest, name: string) => String(req.params[name] || '');

// Every route below is scoped through this: the company always comes from the token, never from the request
export const requireCompany = async (req: CompanyRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const access = await resolveCompanyAccess(String(req.user!.id), req.user!.email);
    if (!access) {
      res.status(403).json({ error: 'لا توجد شركة مرتبطة بهذا الحساب' });
      return;
    }
    if ('suspended' in access) {
      res.status(403).json({ error: `تم إيقاف حسابك في فريق ${access.companyName}، تواصل مع مسؤول الشركة`, code: 'MEMBER_SUSPENDED' });
      return;
    }
    const nameRes = await pool.query('SELECT name FROM users WHERE id = $1', [req.user!.id]);
    req.company = access.company;
    req.access = access;
    req.actor = { id: String(req.user!.id), name: nameRes.rows[0]?.name || req.user!.email || 'عضو الفريق' };
    next();
  } catch (error) {
    console.error('requireCompany error:', error);
    res.status(500).json({ error: 'تعذر التحقق من الشركة' });
  }
};

// Blocks new business while the platform has the company suspended. Serving existing bookings,
// chats with current customers and support tickets stay open so nobody is left stranded.
export const blockWhenSuspended = (req: CompanyRequest, res: Response, next: NextFunction): void => {
  if (isCompanySuspended(req.company)) {
    res.status(403).json({ error: SUSPENDED_ERROR, code: 'COMPANY_SUSPENDED', ...suspensionInfo(req.company) });
    return;
  }
  next();
};

// Pausing or hiding a package is always allowed; publishing one is new business
export const blockPublishWhenSuspended = (req: CompanyRequest, res: Response, next: NextFunction): void => {
  if (req.body?.status === 'active') {
    blockWhenSuspended(req, res, next);
    return;
  }
  next();
};

// Passes when the owner or the member's role has any of the given permissions
export const can = (...permissions: string[]) => (req: CompanyRequest, res: Response, next: NextFunction): void => {
  if (req.access?.isOwner || permissions.some((key) => req.access?.permissions.includes(key))) {
    next();
    return;
  }
  res.status(403).json({ error: 'ليست لديك صلاحية لهذا الإجراء، تواصل مع مسؤول الشركة', code: 'NO_PERMISSION' });
};

// Fields a member sees only with the matching permission. Removing them from every response keeps
// the rule in one place instead of in each endpoint.
const AMOUNT_FIELDS = ['total_price', 'paid_amount', 'receipt_verified_amount'];
const CONTACT_FIELDS = ['client_phone', 'customer_phone'];

const stripFields = (value: any, fields: Set<string>): any => {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fields));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const copy: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!fields.has(key)) copy[key] = stripFields(item, fields);
  }
  return copy;
};

export const redactForMember = (req: CompanyRequest, res: Response, next: NextFunction): void => {
  const access = req.access;
  if (!access || access.isOwner) {
    next();
    return;
  }
  const hidden = new Set<string>();
  if (!access.permissions.includes('orders.view_amounts')) AMOUNT_FIELDS.forEach((key) => hidden.add(key));
  if (!access.permissions.includes('clients.contact')) {
    CONTACT_FIELDS.forEach((key) => hidden.add(key));
    // In client records "phone" and "email" are the customer's own
    if (req.path.startsWith('/clients')) ['phone', 'email'].forEach((key) => hidden.add(key));
  }
  if (!access.permissions.includes('clients.documents') && req.path.startsWith('/clients')) hidden.add('documents');
  if (hidden.size === 0) {
    next();
    return;
  }
  const json = res.json.bind(res);
  res.json = (body: any) => json(stripFields(body, hidden));
  next();
};

const has = (req: CompanyRequest, permission: string) => Boolean(req.access?.isOwner || req.access?.permissions.includes(permission));

const activity = (req: CompanyRequest, action: string, details: string, targetType?: string, targetId?: string | null) =>
  logCompanyActivity(req.company.id, req.actor || {}, action, details, targetType, targetId);

export const getCompanyAccess = async (req: CompanyRequest, res: Response): Promise<void> => {
  const access = req.access!;
  res.json({
    success: true,
    data: {
      is_owner: access.isOwner,
      member_id: access.memberId,
      role_id: access.roleId,
      role_name: access.roleName,
      job_title: access.jobTitle,
      permissions: access.permissions,
      permission_groups: COMPANY_PERMISSION_GROUPS,
      // The company app shows a banner and disables new-business actions while this is set
      suspension: suspensionInfo(req.company),
    },
  });
};

// A 404 rather than a 403, so another company's booking ids cannot be probed
export const requireCompanyBooking = async (req: CompanyRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT b.* FROM bookings b JOIN packages p ON b.package_id = p.id
       WHERE b.id = $1 AND p.company_id = $2`,
      [param(req, 'id'), req.company.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الطلب غير موجود' });
      return;
    }
    req.booking = result.rows[0];
    next();
  } catch (error) {
    console.error('requireCompanyBooking error:', error);
    res.status(500).json({ error: 'تعذر جلب الطلب' });
  }
};

const isCompanyClient = async (companyId: string, companyName: string, userId: string): Promise<boolean> => {
  const result = await pool.query(
    `SELECT 1 WHERE
       EXISTS (SELECT 1 FROM bookings b JOIN packages p ON b.package_id = p.id WHERE b.user_id = $1 AND p.company_id = $2)
       OR EXISTS (SELECT 1 FROM chats c WHERE c.user_id = $1 AND c.ticket_number IS NULL AND (c.company_id = $2 OR c.company_name = $3))`,
    [userId, companyId, companyName]
  );
  return result.rows.length > 0;
};

// new + visit stage done means the client was accepted and is expected at the office to pay
const ORDER_STATE_SQL = `
  CASE
    WHEN b.status = 'cancelled' THEN 'cancelled'
    WHEN b.status = 'completed' THEN 'completed'
    WHEN b.status = 'confirmed' THEN 'confirmed'
    WHEN b.status = 'receipt_review' THEN 'under_review'
    WHEN EXISTS (SELECT 1 FROM trip_stages s WHERE s.booking_id = b.id AND s.stage_order = 1 AND s.status = 'completed') THEN 'pending_payment'
    ELSE 'new'
  END`;

const ORDER_STATE_KEYS = ['new', 'pending_payment', 'under_review', 'confirmed', 'completed', 'cancelled'];

const ORDER_COLUMNS = `
  b.id, b.booking_reference, b.status, b.room_type, b.travelers_count, b.children_count, b.total_price, b.paid_amount,
  b.notes, b.created_at, b.receipt_url, b.receipt_status, b.rejection_reason, b.cancellation_reason, b.cancelled_by,
  b.allow_retry, b.receipt_submitted_at, b.receipt_reviewed_at, b.receipt_uploaded_by, b.traveler_names,
  b.appointment_date, b.appointment_time, b.appointment_status, b.user_id,
  COALESCE(b.customer_name, u.name) AS client_name, COALESCE(b.customer_phone, u.phone) AS client_phone,
  COALESCE(b.governorate, u.city) AS client_city, b.district AS client_district,
  p.id AS package_id, p.title AS package_title, p.duration AS package_duration, p.image_url AS package_image,
  p.departure_date, p.return_date, p.hotel_makkah, p.hotel_madinah,
  (${ORDER_STATE_SQL}) AS order_state,
  (SELECT s.title FROM trip_stages s WHERE s.booking_id = b.id AND s.status = 'current' ORDER BY s.stage_order LIMIT 1) AS current_stage`;

const ORDER_FROM = `
  FROM bookings b
  JOIN packages p ON b.package_id = p.id
  LEFT JOIN users u ON b.user_id = u.id`;

const stageProgressSql = `
  (SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE s.status = 'completed') / NULLIF(COUNT(*), 0)), 0)
   FROM trip_stages s WHERE s.booking_id = b.id)::int`;

// ───── Dashboard ─────

export const getCompanyDashboard = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const { id: companyId, name: companyName } = req.company;

    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'new')::int AS new_orders,
         COUNT(*) FILTER (WHERE state IN ('confirmed'))::int AS confirmed,
         COUNT(*) FILTER (WHERE state = 'pending_payment')::int AS pending_payment,
         COUNT(*) FILTER (WHERE state = 'under_review')::int AS under_review
       FROM (SELECT (${ORDER_STATE_SQL}) AS state FROM bookings b JOIN packages p ON b.package_id = p.id WHERE p.company_id = $1) t`,
      [companyId]
    );
    const trips = await pool.query(
      `SELECT COUNT(DISTINCT p.id)::int AS total
       FROM packages p JOIN bookings b ON b.package_id = p.id
       WHERE p.company_id = $1 AND b.status IN ('confirmed', 'completed')
         AND LEFT(p.departure_date, 7) = TO_CHAR(CURRENT_DATE, 'YYYY-MM')`,
      [companyId]
    );
    const chats = await pool.query(
      `SELECT COUNT(DISTINCT m.chat_id)::int AS total
       FROM messages m JOIN chats c ON m.chat_id = c.id
       WHERE (c.company_id = $1 OR c.company_name = $2) AND c.ticket_number IS NULL
         AND m.sender = 'user' AND m.status = 'sent'`,
      [companyId, companyName]
    );
    const today = await pool.query(
      `SELECT a.id, a.title, a.appointment_time, a.location, u.name AS client_name
       FROM interview_appointments a LEFT JOIN users u ON a.user_id = u.id
       WHERE a.company_name = $1 AND a.appointment_date = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
         AND a.status NOT IN ('cancelled', 'rejected')
       ORDER BY a.appointment_time`,
      [companyName]
    );
    // Shown for follow-up only: the platform reviews receipts, the company cannot act on them
    const receipts = await pool.query(
      `SELECT b.id, b.total_price, b.paid_amount, COALESCE(b.receipt_submitted_at, b.created_at) AS created_at,
         COALESCE(b.customer_name, u.name) AS client_name
       ${ORDER_FROM}
       WHERE p.company_id = $1 AND b.status = 'receipt_review'
       ORDER BY b.receipt_submitted_at DESC NULLS LAST LIMIT 5`,
      [companyId]
    );
    const unread = await pool.query(
      "SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = $1 AND is_read = false AND audience = 'company'",
      [req.user!.id]
    );

    res.json({
      success: true,
      data: {
        ...counts.rows[0],
        trips_this_month: trips.rows[0].total,
        unread_chats: chats.rows[0].total,
        appointments_today: today.rows.length,
        unread_notifications: unread.rows[0].total,
        receipts_in_review: receipts.rows,
        today_appointments: today.rows,
        // What the company still has to complete before customers can see it
        readiness: await getCompanyReadiness(companyId),
        suspension: suspensionInfo(req.company),
      },
    });
  } catch (error) {
    console.error('Company dashboard error:', error);
    res.status(500).json({ error: 'تعذر جلب بيانات الرئيسية' });
  }
};

// ───── Profile ─────

const parseJson = (value: any, fallback: any) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const PROFILE_COLUMNS = `
  c.id, c.name, c.verified, c.field_verified, c.rating, c.reviews_count, c.license_number, c.tax_number,
  c.short_description, c.description, c.phone, c.whatsapp, c.landline_phone, c.contact_email, c.website_url,
  c.social_links, c.city_id, c.address, c.google_maps_url, c.logo_url, c.banner_url, c.working_hours,
  c.holidays_notes, c.commercial_register_url, c.tax_id_url, c.manager_id_url, c.manager_id_back_url,
  c.documents_review, c.max_daily_capacity, c.slot_duration_minutes,
  ci.name AS city_name`;

const readProfile = async (companyId: string) => {
  const result = await pool.query(
    `SELECT ${PROFILE_COLUMNS} FROM companies c LEFT JOIN cities ci ON c.city_id = ci.id WHERE c.id = $1`,
    [companyId]
  );
  const row = result.rows[0];
  return {
    ...row,
    social_links: parseJson(row.social_links, {}),
    working_hours: parseJson(row.working_hours, null),
    documents_review: parseJson(row.documents_review, {}),
  };
};

export const getCompanyProfile = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await readProfile(req.company.id) });
  } catch (error) {
    console.error('Company profile error:', error);
    res.status(500).json({ error: 'تعذر جلب بيانات الشركة' });
  }
};

const FILE_FIELDS = ['logo_url', 'banner_url', 'commercial_register_url', 'tax_id_url', 'manager_id_url', 'manager_id_back_url'];
const DOCUMENT_FIELDS = ['commercial_register_url', 'tax_id_url', 'manager_id_url', 'manager_id_back_url'];
// Column names only ever come from this list, never from the request
const PROFILE_FIELDS = [
  'short_description', 'description', 'phone', 'whatsapp', 'landline_phone', 'contact_email', 'website_url',
  'social_links', 'city_id', 'address', 'google_maps_url', 'working_hours', 'holidays_notes',
  'max_daily_capacity', 'slot_duration_minutes', ...FILE_FIELDS,
];

export const updateCompanyProfile = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const company = req.company;
    const updates: Record<string, any> = {};

    // Official documents and the public profile are separate permissions
    const touchesDocuments = DOCUMENT_FIELDS.some((field) => req.body[field] !== undefined);
    const touchesProfile = PROFILE_FIELDS.some((field) => !DOCUMENT_FIELDS.includes(field) && req.body[field] !== undefined);
    if ((touchesDocuments && !has(req, 'company.documents')) || (touchesProfile && !has(req, 'company.profile'))) {
      res.status(403).json({ error: 'ليست لديك صلاحية لتعديل هذا القسم', code: 'NO_PERMISSION' });
      return;
    }

    for (const field of PROFILE_FIELDS) {
      if (req.body[field] === undefined) continue;
      let value = req.body[field];

      if (FILE_FIELDS.includes(field)) {
        const resolved = await resolveUserUpload(value, req, req.user!.id, company[field]);
        if (resolved === false) {
          res.status(400).json({ error: 'رابط الملف غير صالح' });
          return;
        }
        value = resolved || '';
      } else if (field === 'social_links' || field === 'working_hours') {
        value = JSON.stringify(value);
      }
      updates[field] = value;
    }

    if (updates.city_id) {
      const city = await pool.query('SELECT 1 FROM cities WHERE id = $1', [updates.city_id]);
      if (city.rows.length === 0) {
        res.status(400).json({ error: 'المحافظة غير موجودة' });
        return;
      }
    }

    const columns = Object.keys(updates);
    await pool.query(
      `UPDATE companies SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(', ')} WHERE id = $${columns.length + 1}`,
      [...columns.map((column) => updates[column]), company.id]
    );

    if (updates.city_id && updates.city_id !== company.city_id) {
      await pool.query(
        `UPDATE cities SET total_companies = (SELECT COUNT(*) FROM companies WHERE city_id = cities.id) WHERE id = ANY($1)`,
        [[updates.city_id, company.city_id].filter(Boolean)]
      );
    }

    // Official documents were reviewed by the platform, so replacing one leaves a trail for the admins
    const replacedDocuments = DOCUMENT_FIELDS.filter((field) => updates[field] !== undefined && updates[field] !== company[field]);
    if (replacedDocuments.length > 0) {
      await logAudit(req.user!.email, 'تعديل مستندات شركة', `عدّلت شركة (${company.name}) مستنداتها الرسمية`, req.ip, req.user!.email, null, null);
      // A new or replaced document waits for the platform to review it again
      const review = parseJson(company.documents_review, {}) || {};
      for (const field of replacedDocuments) {
        review[field] = updates[field] ? { status: 'pending', updated_at: new Date().toISOString() } : undefined;
      }
      await pool.query('UPDATE companies SET documents_review = $1 WHERE id = $2', [JSON.stringify(review), company.id]);
      if (io) io.to('staff').emit('company_documents_updated', { companyId: company.id });
      if (replacedDocuments.some((field) => updates[field])) {
        await createAdminAlert({
          type: 'company_documents',
          module: 'companies',
          title: 'مستندات شركة بانتظار المراجعة',
          body: `${company.name} رفعت أو عدّلت مستنداتها الرسمية`,
          entityType: 'company',
          entityId: company.id,
          link: `/companies/${company.id}`,
          requiresAction: true,
          merge: true,
        });
      }
    }

    await activity(req, touchesDocuments ? 'documents_updated' : 'profile_updated', touchesDocuments ? 'عدّل المستندات الرسمية للشركة' : `عدّل بيانات الشركة (${columns.join('، ')})`, 'company', company.id);
    res.json({ success: true, message: 'تم حفظ التعديلات', data: await readProfile(company.id) });
  } catch (error) {
    console.error('Update company profile error:', error);
    res.status(500).json({ error: 'تعذر حفظ التعديلات' });
  }
};

// ───── Packages ─────

const formatPackage = (row: any) => ({
  ...row,
  room_prices: parseJson(row.room_prices, {}),
  features: parseJson(row.features, []),
  itinerary: parseJson(row.itinerary, []),
  gallery: parseJson(row.gallery, []),
  exclusions: parseJson(row.exclusions, []),
  bookings_count: Number(row.bookings_count || 0),
  seats_booked: row.seats_booked !== undefined ? Number(row.seats_booked) : undefined,
  views_count: Number(row.views_count || 0),
  shares_count: Number(row.shares_count || 0),
  favorites_count: Number(row.favorites_count || 0),
});

const findOwnPackage = async (req: CompanyRequest) => {
  const result = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) AS bookings_count
     FROM packages p WHERE p.id = $1 AND p.company_id = $2`,
    [param(req, 'id'), req.company.id]
  );
  return result.rows[0] || null;
};

export const getCompanyPackagesList = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) AS bookings_count,
         (SELECT COALESCE(SUM(b.travelers_count), 0) FROM bookings b WHERE b.package_id = p.id AND b.status <> 'cancelled')::int AS seats_booked,
         (SELECT COUNT(*) FROM favorites f WHERE f.package_id = p.id)::int AS favorites_count
       FROM packages p WHERE p.company_id = $1 ORDER BY p.created_at DESC`,
      [req.company.id]
    );
    res.json({ success: true, data: result.rows.map(formatPackage) });
  } catch (error) {
    console.error('Company packages error:', error);
    res.status(500).json({ error: 'تعذر جلب الباقات' });
  }
};

export const getCompanyPackageDetails = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const row = await findOwnPackage(req);
    if (!row) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    res.json({ success: true, data: formatPackage(row) });
  } catch (error) {
    console.error('Company package error:', error);
    res.status(500).json({ error: 'تعذر جلب الباقة' });
  }
};

// The customer app sorts and filters by this, and it is the "starting from" price
const lowestAdultPrice = (roomPrices: Record<string, string>): number | null => {
  const prices = ['quad', 'triple', 'double', 'single'].map((key) => Number(roomPrices[key])).filter((value) => value > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
};

const packageValues = (body: any, imageUrl: string) => [
  body.title,
  body.duration,
  lowestAdultPrice(body.room_prices),
  imageUrl,
  body.description,
  JSON.stringify(body.features.filter(Boolean)),
  body.nights_count ? parseInt(body.nights_count, 10) : null,
  body.departure_date,
  body.return_date,
  body.departure_airport,
  body.hotel_makkah,
  body.hotel_madinah,
  JSON.stringify(body.room_prices),
  body.max_adults,
  body.max_children,
  body.cancellation_policy,
  JSON.stringify(body.itinerary.filter((item: any) => item.title)),
];

// Fields added after the first package form; saved in a second statement so the main one keeps its shape
const preparePackageExtras = async (
  req: CompanyRequest,
  existing: any | null
): Promise<{ error: string } | { values: any[] }> => {
  const body = req.body;
  // Gallery images already on the package are kept as is; new ones must be the saver's own uploads
  const known = new Set<string>();
  if (existing) {
    const previous = parseJson(existing.gallery, []);
    if (Array.isArray(previous)) previous.forEach((url: string) => known.add(String(url).split('/').pop() || ''));
  }
  const gallery: string[] = [];
  for (const raw of body.gallery || []) {
    const url = normalizeUploadUrl(raw, req);
    if (url === false) return { error: 'إحدى صور الألبوم غير صالحة، ارفعها مرة أخرى' };
    if (!url) continue;
    if (known.has(url.split('/').pop() || '')) {
      gallery.push(url);
      continue;
    }
    const owned = await resolveUserUpload(url, req, req.user!.id, null);
    if (!owned) return { error: 'إحدى صور الألبوم غير صالحة، ارفعها مرة أخرى' };
    gallery.push(owned);
  }
  const seats = body.seats_total ? parseInt(body.seats_total, 10) : null;
  const originalPrice = body.original_price ? Number(body.original_price) : null;
  const lowest = lowestAdultPrice(body.room_prices);
  if (originalPrice !== null && lowest !== null && originalPrice <= lowest) {
    return { error: 'السعر قبل الخصم يجب أن يكون أكبر من سعر الباقة' };
  }
  return {
    values: [
      JSON.stringify(gallery),
      JSON.stringify((body.exclusions || []).filter(Boolean)),
      seats,
      body.visa_info || null,
      body.transport_info || null,
      originalPrice,
      Boolean(body.includes_flight),
      body.season || null,
    ],
  };
};

const applyPackageExtras = async (packageId: string, values: any[]) => {
  const result = await pool.query(
    `UPDATE packages SET gallery = $1, exclusions = $2, seats_total = $3, visa_info = $4, transport_info = $5,
       original_price = $6, includes_flight = $7, season = $8
     WHERE id = $9 RETURNING *`,
    [...values, packageId]
  );
  return result.rows[0];
};

export const createCompanyOwnPackage = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const company = req.company;
    if (!company.city_id) {
      res.status(400).json({ error: 'حدد محافظة الشركة أولاً من قسم العنوان والموقع' });
      return;
    }
    const image = await resolveUserUpload(req.body.image_url, req, req.user!.id);
    if (image === false) {
      res.status(400).json({ error: 'رابط الصورة غير صالح' });
      return;
    }
    const extras = await preparePackageExtras(req, null);
    if ('error' in extras) {
      res.status(400).json({ error: extras.error });
      return;
    }

    const result = await pool.query(
      `INSERT INTO packages (
         title, duration, price, image_url, description, features, nights_count, departure_date, return_date,
         departure_airport, hotel_makkah, hotel_madinah, room_prices, max_adults, max_children, cancellation_policy,
         itinerary, id, company_id, city_id, public_id, rating, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,0,'active')
       RETURNING *`,
      [...packageValues(req.body, image || ''), generate16CharId(), company.id, company.city_id, generate16CharId()]
    );
    await pool.query(
      'UPDATE cities SET total_packages = (SELECT COUNT(*) FROM packages WHERE city_id = $1) WHERE id = $1',
      [company.city_id]
    );
    const created = await applyPackageExtras(result.rows[0].id, extras.values);
    await activity(req, 'package_created', `أضاف الباقة "${created.title}"`, 'package', created.id);
    res.status(201).json({ success: true, message: 'تم إنشاء الباقة', data: formatPackage(created) });
  } catch (error) {
    console.error('Create company package error:', error);
    res.status(500).json({ error: 'تعذر إنشاء الباقة' });
  }
};

export const updateCompanyOwnPackage = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const existing = await findOwnPackage(req);
    if (!existing) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    const image = await resolveUserUpload(req.body.image_url, req, req.user!.id, existing.image_url);
    if (image === false) {
      res.status(400).json({ error: 'رابط الصورة غير صالح' });
      return;
    }
    const extras = await preparePackageExtras(req, existing);
    if ('error' in extras) {
      res.status(400).json({ error: extras.error });
      return;
    }
    const seatsBooked = await pool.query(
      `SELECT COALESCE(SUM(travelers_count), 0)::int AS total FROM bookings WHERE package_id = $1 AND status <> 'cancelled'`,
      [existing.id]
    );
    const seats = extras.values[2];
    if (seats !== null && seats < seatsBooked.rows[0].total) {
      res.status(400).json({ error: `حُجز ${seatsBooked.rows[0].total} مقعد بالفعل، لا يمكن أن يقل عدد المقاعد عن ذلك` });
      return;
    }
    const result = await pool.query(
      `UPDATE packages SET
         title = $1, duration = $2, price = $3, image_url = $4, description = $5, features = $6, nights_count = $7,
         departure_date = $8, return_date = $9, departure_airport = $10, hotel_makkah = $11, hotel_madinah = $12,
         room_prices = $13, max_adults = $14, max_children = $15, cancellation_policy = $16, itinerary = $17
       WHERE id = $18 AND company_id = $19 RETURNING *`,
      [...packageValues(req.body, image || ''), existing.id, req.company.id]
    );
    const updated = await applyPackageExtras(existing.id, extras.values);
    await activity(req, 'package_updated', `عدّل الباقة "${updated.title}"`, 'package', existing.id);
    res.json({ success: true, message: 'تم تحديث الباقة', data: formatPackage(updated) });
  } catch (error) {
    console.error('Update company package error:', error);
    res.status(500).json({ error: 'تعذر تحديث الباقة' });
  }
};

export const updateCompanyPackageStatus = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const existing = await findOwnPackage(req);
    if (!existing) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    if (existing.status === 'hidden') {
      res.status(403).json({ error: 'أخفت إدارة المنصة هذه الباقة، يرجى التواصل مع الدعم الفني' });
      return;
    }
    const result = await pool.query('UPDATE packages SET status = $1 WHERE id = $2 RETURNING *', [req.body.status, existing.id]);
    await activity(req, 'package_status', `${req.body.status === 'active' ? 'نشر' : 'أوقف'} الباقة "${existing.title}"`, 'package', existing.id);
    res.json({ success: true, data: formatPackage(result.rows[0]) });
  } catch (error) {
    console.error('Company package status error:', error);
    res.status(500).json({ error: 'تعذر تغيير حالة الباقة' });
  }
};

export const deleteCompanyOwnPackage = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const existing = await findOwnPackage(req);
    if (!existing) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    // Deleting a package cascades to its bookings, which would erase customers' reservations
    if (Number(existing.bookings_count) > 0) {
      res.status(409).json({ error: 'لا يمكن حذف باقة عليها حجوزات، يمكنك إيقافها بدلاً من ذلك' });
      return;
    }
    await pool.query('DELETE FROM packages WHERE id = $1 AND company_id = $2', [existing.id, req.company.id]);
    await pool.query(
      'UPDATE cities SET total_packages = (SELECT COUNT(*) FROM packages WHERE city_id = $1) WHERE id = $1',
      [existing.city_id]
    );
    await activity(req, 'package_deleted', `حذف الباقة "${existing.title}"`, 'package', existing.id);
    res.json({ success: true, message: 'تم حذف الباقة' });
  } catch (error) {
    console.error('Delete company package error:', error);
    res.status(500).json({ error: 'تعذر حذف الباقة' });
  }
};

// ───── Orders ─────

export const getCompanyOrders = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    // Without ?page the full list is returned (the trips screen groups all of it)
    if (req.query.page === undefined) {
      const result = await pool.query(
        `SELECT ${ORDER_COLUMNS}, ${stageProgressSql} AS progress
         ${ORDER_FROM}
         WHERE p.company_id = $1
         ORDER BY b.created_at DESC LIMIT 500`,
        [req.company.id]
      );
      res.json({ success: true, data: result.rows });
      return;
    }

    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit || '20'), 10) || 20));
    const state = ORDER_STATE_KEYS.includes(String(req.query.state)) ? String(req.query.state) : null;
    const search = String(req.query.q || '').trim().slice(0, 100);
    const searchSql = `($3::text = '' OR COALESCE(b.customer_name, u.name, '') ILIKE '%' || $3 || '%'
      OR b.booking_reference ILIKE '%' || $3 || '%' OR p.title ILIKE '%' || $3 || '%'
      OR COALESCE(b.customer_phone, u.phone, '') ILIKE '%' || $3 || '%')`;

    const rows = await pool.query(
      `SELECT * FROM (
         SELECT ${ORDER_COLUMNS}, ${stageProgressSql} AS progress ${ORDER_FROM}
         WHERE p.company_id = $1 AND ${searchSql}
       ) o
       WHERE ($2::text IS NULL OR o.order_state = $2)
       ORDER BY o.created_at DESC
       LIMIT $4 OFFSET $5`,
      [req.company.id, state, search, limit + 1, (page - 1) * limit]
    );
    const counts = await pool.query(
      `SELECT (${ORDER_STATE_SQL}) AS state, COUNT(*)::int AS total ${ORDER_FROM}
       WHERE p.company_id = $1 AND ${searchSql.replace(/\$3/g, '$2')}
       GROUP BY 1`,
      [req.company.id, search]
    );
    const byState: Record<string, number> = { all: 0 };
    for (const row of counts.rows) {
      byState[row.state] = row.total;
      byState.all += row.total;
    }

    const hasMore = rows.rows.length > limit;
    res.json({
      success: true,
      data: rows.rows.slice(0, limit),
      pagination: { page, limit, has_more: hasMore, total: state ? byState[state] || 0 : byState.all },
      counts: byState,
    });
  } catch (error) {
    console.error('Company orders error:', error);
    res.status(500).json({ error: 'تعذر جلب الطلبات' });
  }
};

const readOrder = async (bookingId: string, companyId: string) => {
  const order = await pool.query(
    `SELECT ${ORDER_COLUMNS}, ${stageProgressSql} AS progress ${ORDER_FROM} WHERE b.id = $1 AND p.company_id = $2`,
    [bookingId, companyId]
  );
  const stages = await pool.query(
    `SELECT id, stage_order, title, subtitle, status, stage_date, traveler_name, document_url, document_number, details, instructions
     FROM trip_stages WHERE booking_id = $1 ORDER BY stage_order`,
    [bookingId]
  );
  const row = order.rows[0];
  return row ? { ...row, traveler_names: parseTravelerNames(row.traveler_names), stages: stages.rows } : row;
};

// [{ name, type: 'adult' | 'child' }], in the order the company entered them
const parseTravelerNames = (raw: unknown): Array<{ name: string; type: 'adult' | 'child' }> => {
  const list = parseJson(raw, []);
  return Array.isArray(list)
    ? list
        .filter((item: any) => item && typeof item.name === 'string' && item.name.trim())
        .map((item: any) => ({ name: String(item.name).trim(), type: item.type === 'child' ? 'child' : 'adult' }))
    : [];
};

export const getCompanyOrderDetails = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await readOrder(req.booking.id, req.company.id) });
  } catch (error) {
    console.error('Company order details error:', error);
    res.status(500).json({ error: 'تعذر جلب تفاصيل الطلب' });
  }
};

// Accepting completes the visit stage, which is what lets the customer upload a payment receipt
export const acceptCompanyOrder = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const booking = req.booking;
    if (booking.status !== 'new') {
      res.status(409).json({ error: 'تمت معالجة هذا الطلب بالفعل' });
      return;
    }
    const done = await pool.query(
      `UPDATE trip_stages SET status = 'completed' WHERE booking_id = $1 AND stage_order = 1 AND status <> 'completed' RETURNING id`,
      [booking.id]
    );
    if (done.rows.length === 0) {
      res.status(409).json({ error: 'سُجّلت زيارة هذا العميل بالفعل' });
      return;
    }
    await pool.query(
      `UPDATE trip_stages SET status = 'current' WHERE booking_id = $1 AND stage_order = 2 AND status = 'pending'`,
      [booking.id]
    );
    // Accepting the order is the visit itself, so the appointment counts as attended
    await markAppointmentAttended(booking.user_id, req.company.name, booking.id);

    await createAndSendNotification({
      userId: booking.user_id,
      title: 'تم تسجيل زيارتك',
      subtitle: `سجّلت ${req.company.name} زيارتك للحجز #${booking.booking_reference}. يمكنك الآن رفع إيصال الدفع من تفاصيل الحجز.`,
      category: 'booking',
      icon: 'checkmark-circle-outline',
      iconBg: '#ECFDF5',
      iconColor: '#059669',
      data: { type: 'booking_status', status: 'accepted', bookingRef: booking.booking_reference },
    });

    await activity(req, 'order_accepted', `سجّل زيارة العميل للحجز #${booking.booking_reference}`, 'order', booking.id);
    res.json({ success: true, message: 'تم تسجيل الزيارة، ويمكن للعميل الآن رفع إيصال الدفع', data: await readOrder(booking.id, req.company.id) });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({ error: 'تعذر تسجيل الزيارة' });
  }
};

export const rejectCompanyOrder = async (req: CompanyRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = req.booking;
    if (booking.status !== 'new') {
      res.status(409).json({ error: 'لا يمكن رفض طلب تمت معالجته' });
      return;
    }
    req.body = { status: 'cancelled', cancellation_reason: req.body.reason, cancelled_by: 'company' };
    // Checked again on the locked booking: a second reject or a receipt sent meanwhile is refused
    (req as BookingStatusRequest).bookingPrecondition = async (_client, locked) =>
      (locked.status || 'new') === 'new' ? null : { code: 409, error: 'لا يمكن رفض طلب تمت معالجته' };
    await updateBookingStatusByAdmin(req, res);
    if (res.statusCode >= 400) return;
    // A rejected request ends every stage, including a visit already recorded
    await pool.query(`UPDATE trip_stages SET status = 'cancelled' WHERE booking_id = $1`, [booking.id]);
    await activity(req, 'order_rejected', `رفض طلب الحجز #${booking.booking_reference}: ${req.body.cancellation_reason}`, 'order', booking.id);
  } catch (error) {
    next(error);
  }
};

// The order is accepted, and either no receipt was sent yet or the platform rejected it and allows another
const isAwaitingPayment = async (booking: any): Promise<boolean> => {
  if (booking.status !== 'new') return false;
  const visit = await pool.query(
    `SELECT 1 FROM trip_stages WHERE booking_id = $1 AND stage_order = 1 AND status = 'completed'`,
    [booking.id]
  );
  return visit.rows.length > 0;
};

// Before payment the company may still withdraw; after a receipt is sent only the platform decides
export const cancelCompanyOrder = async (req: CompanyRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const booking = req.booking;
    if (!(await isAwaitingPayment(booking))) {
      res.status(409).json({
        error: booking.status === 'receipt_review'
          ? 'الإيصال قيد مراجعة الإدارة، تواصل مع دعم سدرة لإلغاء الحجز'
          : 'لا يمكن إلغاء هذا الطلب من التطبيق، تواصل مع دعم سدرة',
      });
      return;
    }
    req.body = { status: 'cancelled', cancellation_reason: req.body.reason, cancelled_by: 'company' };
    // Checked again on the locked booking: a receipt uploaded since the check above moves the decision to the platform
    (req as BookingStatusRequest).bookingPrecondition = async (client, locked) => {
      if ((locked.status || 'new') !== 'new') {
        return { code: 409, error: 'الإيصال قيد مراجعة الإدارة، تواصل مع دعم سدرة لإلغاء الحجز' };
      }
      const visit = await client.query(
        `SELECT 1 FROM trip_stages WHERE booking_id = $1 AND stage_order = 1 AND status = 'completed'`,
        [locked.id]
      );
      return visit.rows.length > 0 ? null : { code: 409, error: 'لا يمكن إلغاء هذا الطلب من التطبيق، تواصل مع دعم سدرة' };
    };
    // The status update also ends the stages that were not completed, inside the same transaction
    await updateBookingStatusByAdmin(req, res);
    if (res.statusCode >= 400) return;
    await activity(req, 'order_cancelled', `ألغى الحجز #${booking.booking_reference}: ${req.body.cancellation_reason}`, 'order', booking.id);
  } catch (error) {
    next(error);
  }
};

// Reminds an accepted client to pay and send the receipt; limited to one reminder a day per booking
export const remindCompanyOrderPayment = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const booking = req.booking;
    if (!(await isAwaitingPayment(booking))) {
      res.status(409).json({ error: 'هذا الطلب لا ينتظر الدفع' });
      return;
    }
    const recent = await pool.query(
      `SELECT 1 FROM company_activity
       WHERE company_id = $1 AND action = 'payment_reminder' AND target_type = 'order' AND target_id = $2
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [req.company.id, booking.id]
    );
    if (recent.rows.length > 0) {
      res.status(429).json({ error: 'تم إرسال تذكير لهذا العميل خلال آخر 24 ساعة' });
      return;
    }
    await createAndSendNotification({
      userId: booking.user_id,
      title: 'تذكير بإتمام الدفع',
      subtitle: `تذكّرك ${req.company.name} بإتمام الدفع في مكتبها ورفع الإيصال لتأكيد حجزك #${booking.booking_reference}.`,
      category: 'booking',
      icon: 'time-outline',
      iconBg: '#FFFBEB',
      iconColor: '#D97706',
      data: { type: 'payment_reminder', bookingRef: booking.booking_reference },
    });
    await activity(req, 'payment_reminder', `أرسل تذكيراً بالدفع للحجز #${booking.booking_reference}`, 'order', booking.id);
    res.json({ success: true, message: 'تم إرسال التذكير للعميل' });
  } catch (error) {
    console.error('Payment reminder error:', error);
    res.status(500).json({ error: 'تعذر إرسال التذكير' });
  }
};

// ───── Traveler names ─────

export const saveOrderTravelerNames = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const booking = req.booking;
    if (booking.status === 'cancelled') {
      res.status(409).json({ error: 'لا يمكن تعديل حجز ملغي' });
      return;
    }
    const names = parseTravelerNames(req.body.names);
    const adults = Number(booking.travelers_count || 0) - Number(booking.children_count || 0);
    const children = Number(booking.children_count || 0);
    if (names.filter((item) => item.type === 'adult').length > adults || names.filter((item) => item.type === 'child').length > children) {
      res.status(400).json({ error: `الحجز لعدد ${adults} بالغ${children ? ` و${children} طفل` : ''}` });
      return;
    }
    if (names.some((item) => item.name.length < 3)) {
      res.status(400).json({ error: 'اكتب اسم كل مسافر كما في جواز السفر' });
      return;
    }
    const lower = names.map((item) => item.name.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      res.status(400).json({ error: 'يوجد اسم مكرر، اكتب الاسم بالكامل لتمييز كل مسافر' });
      return;
    }
    // A name already used on a document cannot disappear, or that document would lose its owner
    const previous = parseTravelerNames(booking.traveler_names).map((item) => item.name);
    const removed = previous.filter((name) => !names.some((item) => item.name === name));
    if (removed.length > 0) {
      const stages = await pool.query('SELECT details FROM trip_stages WHERE booking_id = $1 AND details IS NOT NULL', [booking.id]);
      const used = new Set<string>();
      for (const stage of stages.rows) {
        const rows = parseJson(stage.details, []);
        if (Array.isArray(rows)) rows.forEach((row: any) => row?.name && used.add(String(row.name)));
      }
      const blocked = removed.find((name) => used.has(name));
      if (blocked) {
        res.status(409).json({ error: `لـ "${blocked}" مستندات مرفوعة، احذف مستنداته من المراحل قبل تغيير اسمه` });
        return;
      }
    }
    await pool.query('UPDATE bookings SET traveler_names = $1 WHERE id = $2', [JSON.stringify(names), booking.id]);
    await activity(req, 'traveler_names', `حدّث أسماء المسافرين في الحجز #${booking.booking_reference} (${names.length})`, 'order', booking.id);
    res.json({ success: true, message: 'تم حفظ أسماء المسافرين', data: await readOrder(booking.id, req.company.id) });
  } catch (error) {
    console.error('Traveler names error:', error);
    res.status(500).json({ error: 'تعذر حفظ أسماء المسافرين' });
  }
};

// ───── Finance ─────

// The commission rule currently applied to new bookings, in words the company understands
const describeCommission = (settings: Record<string, string>) => {
  const enabled = settings.commission_system_enabled !== 'false';
  const method = settings.commission_method || 'percentage_total';
  if (!enabled) return { enabled, method, text: 'لا تُحتسب عمولة على الحجوزات حالياً' };
  if (method === 'per_individual') {
    return {
      enabled,
      method,
      adult_rate: Number(settings.adult_commission_rate || 5),
      child_rate: Number(settings.child_commission_rate || 2),
      text: `${Number(settings.adult_commission_rate || 5)}% عن كل بالغ و${Number(settings.child_commission_rate || 2)}% عن كل طفل من قيمة الحجز`,
    };
  }
  if (method === 'fixed_amount') {
    const amount = Number(settings.fixed_commission_amount || settings.platform_commission_fee || 50);
    return { enabled, method, fixed_amount: amount, text: `مبلغ ثابت ${amount} عن كل حجز مؤكد` };
  }
  const pct = Number(settings.commission_percentage || 5);
  return { enabled, method, percentage: pct, text: `${pct}% من إجمالي قيمة الحجز` };
};

export const getCompanyFinance = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.company.id;
    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE b.receipt_approved)::int AS confirmed_count,
         COALESCE(SUM(COALESCE(b.receipt_verified_amount, b.paid_amount, b.total_price)) FILTER (WHERE b.receipt_approved), 0)::float AS confirmed_sales,
         COUNT(*) FILTER (WHERE b.status = 'receipt_review')::int AS in_review_count,
         COALESCE(SUM(COALESCE(b.paid_amount, b.total_price)) FILTER (WHERE b.status = 'receipt_review'), 0)::float AS in_review_sales,
         COALESCE(SUM(pe.commission_amount) FILTER (WHERE pe.status = 'recorded'), 0)::float AS commission_total,
         COALESCE(SUM(pe.commission_amount) FILTER (WHERE pe.status = 'recorded' AND pe.settlement_id IS NOT NULL), 0)::float AS commission_settled,
         COALESCE(SUM(pe.commission_amount) FILTER (WHERE pe.status = 'recorded' AND DATE_TRUNC('month', b.receipt_reviewed_at) = DATE_TRUNC('month', NOW())), 0)::float AS commission_this_month,
         COALESCE(SUM(COALESCE(b.receipt_verified_amount, b.paid_amount, b.total_price))
           FILTER (WHERE b.receipt_approved AND DATE_TRUNC('month', b.receipt_reviewed_at) = DATE_TRUNC('month', NOW())), 0)::float AS sales_this_month
       FROM bookings b
       JOIN packages p ON b.package_id = p.id
       LEFT JOIN platform_earnings pe ON pe.booking_id = b.id
       WHERE p.company_id = $1`,
      [companyId]
    );
    const items = await pool.query(
      `SELECT b.id, b.booking_reference, COALESCE(b.customer_name, u.name) AS client_name, p.title AS package_title,
         COALESCE(b.receipt_verified_amount, b.paid_amount, b.total_price)::float AS amount,
         COALESCE(pe.commission_amount, b.commission_amount, 0)::float AS commission,
         b.commission_method_used, b.commission_rate_used,
         (pe.settlement_id IS NOT NULL) AS settled, pe.settled_at,
         b.receipt_reviewed_at, b.status
       ${ORDER_FROM}
       LEFT JOIN platform_earnings pe ON pe.booking_id = b.id
       WHERE p.company_id = $1 AND b.receipt_approved = TRUE
       ORDER BY b.receipt_reviewed_at DESC NULLS LAST LIMIT 100`,
      [companyId]
    );
    const settlements = await pool.query(
      `SELECT id, amount::float AS amount, earnings_count, method, reference, note, created_at
       FROM company_settlements WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [companyId]
    );
    const settingsRes = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('commission_system_enabled', 'commission_method', 'commission_percentage',
         'adult_commission_rate', 'child_commission_rate', 'fixed_commission_amount', 'platform_commission_fee')`
    );
    const settings = Object.fromEntries(settingsRes.rows.map((row: any) => [row.key, row.value]));

    const row = totals.rows[0];
    res.json({
      success: true,
      data: {
        ...row,
        net_total: row.confirmed_sales - row.commission_total,
        // What the company still owes the platform for confirmed bookings
        commission_due: Math.max(0, row.commission_total - row.commission_settled),
        commission_terms: describeCommission(settings),
        items: items.rows.map((item: any) => ({ ...item, net: item.amount - item.commission })),
        settlements: settlements.rows,
      },
    });
  } catch (error) {
    console.error('Company finance error:', error);
    res.status(500).json({ error: 'تعذر جلب البيانات المالية' });
  }
};
// ───── Reviews ─────

// The reply shows under the review in the customer app; an empty reply removes it
export const replyCompanyReview = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const reply = String(req.body.reply || '').trim();
    const review = await pool.query(
      `SELECT id, user_id, company_reply FROM reviews WHERE id = $1 AND company_id = $2 AND COALESCE(hidden, FALSE) = FALSE`,
      [param(req, 'id'), req.company.id]
    );
    const row = review.rows[0];
    if (!row) {
      res.status(404).json({ error: 'التقييم غير موجود' });
      return;
    }
    const updated = await pool.query(
      `UPDATE reviews SET company_reply = NULLIF($1, ''), company_reply_at = CASE WHEN $1 = '' THEN NULL ELSE NOW() END,
         company_reply_by = CASE WHEN $1 = '' THEN NULL ELSE $2 END
       WHERE id = $3 RETURNING id, company_reply, company_reply_at, company_reply_by`,
      [reply, req.actor?.name || req.company.name, row.id]
    );
    await activity(req, reply ? 'review_replied' : 'review_reply_removed', reply ? 'ردّ على تقييم عميل' : 'حذف الرد على تقييم', 'review', row.id);

    // The customer hears about the first answer, not every later edit
    if (reply && !row.company_reply && row.user_id) {
      await createAndSendNotification({
        userId: row.user_id,
        title: `ردّت ${req.company.name} على تقييمك`,
        subtitle: reply.length > 120 ? `${reply.slice(0, 117)}...` : reply,
        category: 'review',
        icon: 'chatbubble-outline',
        iconBg: '#F8F5EE',
        iconColor: '#C8A96A',
        data: { type: 'review_reply', reviewId: row.id, companyId: req.company.id },
      });
    }
    res.json({ success: true, message: reply ? 'تم نشر الرد' : 'تم حذف الرد', data: updated.rows[0] });
  } catch (error) {
    console.error('Review reply error:', error);
    res.status(500).json({ error: 'تعذر حفظ الرد' });
  }
};

export const getCompanyReviews = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.rating::float AS rating, r.comment, r.created_at, COALESCE(u.name, 'عميل') AS client_name,
         r.company_reply, r.company_reply_at, r.company_reply_by
       FROM reviews r LEFT JOIN users u ON r.user_id = u.id
       WHERE r.company_id = $1 AND COALESCE(r.hidden, FALSE) = FALSE
       ORDER BY r.created_at DESC LIMIT 200`,
      [req.company.id]
    );
    const rows = result.rows;
    const average = rows.length ? rows.reduce((sum: number, r: any) => sum + Number(r.rating || 0), 0) / rows.length : 0;
    const distribution = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: rows.filter((r: any) => Math.round(Number(r.rating)) === stars).length }));
    res.json({ success: true, data: { average: Math.round(average * 10) / 10, count: rows.length, distribution, items: rows } });
  } catch (error) {
    console.error('Company reviews error:', error);
    res.status(500).json({ error: 'تعذر جلب التقييمات' });
  }
};

const STAGE_DOC_TYPES = ['visa', 'ticket', 'hotel', 'other'];

// Each document link must point to a file the platform stored. A file already attached to this stage is kept
// as is; a new one must have been uploaded by the person saving it, so nobody can attach someone else's file.
const resolveStageFile = async (req: CompanyRequest, raw: unknown, existing: Set<string>): Promise<string | null | false> => {
  const url = normalizeUploadUrl(raw, req);
  if (!url) return url;
  const name = url.split('/').pop();
  for (const known of existing) {
    if (known.split('/').pop() === name) return url;
  }
  return resolveUserUpload(url, req, req.user!.id, null);
};

/**
 * Saves a trip stage: one document per traveler (visa, ticket, hotel voucher), travel instructions, and
 * optionally completes it. Documents can be corrected after completion; the customer sees them in
 * "مستندات رحلتي" and is notified.
 */
export const saveCompanyStage = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const booking = req.booking;
    // The visit, receipt and confirmation stages move only through the order and the receipt review
    if (!booking.receipt_approved || !['confirmed', 'completed'].includes(booking.status)) {
      res.status(409).json({ error: 'لا يمكن تحديث مراحل الرحلة قبل اعتماد الإيصال' });
      return;
    }
    const stageRes = await pool.query('SELECT * FROM trip_stages WHERE id = $1 AND booking_id = $2', [param(req, 'stageId'), booking.id]);
    const stage = stageRes.rows[0];
    if (!stage || stage.stage_order < 3) {
      res.status(404).json({ error: 'المرحلة غير موجودة' });
      return;
    }
    if (stage.status === 'cancelled') {
      res.status(409).json({ error: 'هذه المرحلة ملغاة' });
      return;
    }

    const complete = req.body.complete === true || req.path.endsWith('/complete');
    if (complete && stage.status === 'completed') {
      res.status(409).json({ error: 'هذه المرحلة مكتملة بالفعل' });
      return;
    }
    if (complete) {
      const previous = await pool.query('SELECT status FROM trip_stages WHERE booking_id = $1 AND stage_order = $2', [booking.id, stage.stage_order - 1]);
      if (previous.rows[0] && previous.rows[0].status !== 'completed') {
        res.status(400).json({ error: 'أكمل المرحلة السابقة أولاً' });
        return;
      }
    }

    // Files already on this stage, which may have been uploaded by another team member
    const existing = new Set<string>([stage.document_url].filter(Boolean));
    const previousTravelers = parseJson(stage.details, []);
    if (Array.isArray(previousTravelers)) previousTravelers.forEach((row: any) => row?.docUrl && existing.add(String(row.docUrl)));

    let details: string | null | undefined;
    if (Array.isArray(req.body.travelers)) {
      // Every document belongs to a traveler of this booking, so names are never misspelled or mixed up
      const known = parseTravelerNames(booking.traveler_names).map((item) => item.name);
      if (req.body.travelers.length > 0 && known.length === 0) {
        res.status(400).json({ error: 'أدخل أسماء المسافرين في الطلب أولاً، ثم ارفع مستند كل مسافر باسمه', code: 'NAMES_REQUIRED' });
        return;
      }
      const unknown = req.body.travelers.find((row: any) => !known.includes(String(row.name || '').trim()));
      if (unknown) {
        res.status(400).json({ error: `"${unknown.name}" ليس من مسافري هذا الحجز` });
        return;
      }
      const rows = [];
      for (const row of req.body.travelers) {
        const docUrl = await resolveStageFile(req, row.docUrl, existing);
        if (docUrl === false) {
          res.status(400).json({ error: `ملف المستند الخاص بـ ${row.name || 'المسافر'} غير صالح، ارفعه مرة أخرى` });
          return;
        }
        rows.push({
          name: String(row.name || '').trim(),
          docNumber: String(row.docNumber || '').trim(),
          docUrl: docUrl || null,
          docType: STAGE_DOC_TYPES.includes(row.docType) ? row.docType : undefined,
        });
      }
      details = rows.length > 0 ? JSON.stringify(rows) : null;
    }

    const documentUrl = req.body.document_url !== undefined ? await resolveStageFile(req, req.body.document_url, existing) : undefined;
    if (documentUrl === false) {
      res.status(400).json({ error: 'رابط المستند غير صالح' });
      return;
    }
    const instructions = req.body.instructions !== undefined ? String(req.body.instructions).trim() || null : undefined;

    await pool.query(
      `UPDATE trip_stages SET
         details = CASE WHEN $1::boolean THEN $2 ELSE details END,
         document_url = CASE WHEN $3::boolean THEN $4 ELSE document_url END,
         document_number = COALESCE($5, document_number),
         traveler_name = COALESCE($6, traveler_name),
         instructions = CASE WHEN $7::boolean THEN $8 ELSE instructions END,
         status = CASE WHEN $9::boolean THEN 'completed' ELSE status END
       WHERE id = $10`,
      [
        details !== undefined, details ?? null,
        documentUrl !== undefined, documentUrl ?? null,
        req.body.document_number || null,
        req.body.traveler_name || null,
        instructions !== undefined, instructions ?? null,
        complete,
        stage.id,
      ]
    );

    if (complete) {
      await pool.query(
        `UPDATE trip_stages SET status = 'current' WHERE booking_id = $1 AND stage_order = $2 AND status = 'pending'`,
        [booking.id, stage.stage_order + 1]
      );
      await pool.query(
        `UPDATE bookings b SET status = 'completed' WHERE b.id = $1 AND b.status <> 'cancelled' AND b.receipt_approved = TRUE
         AND NOT EXISTS (SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id AND ts.status <> 'completed')`,
        [booking.id]
      );
    }

    const documentsAdded = details !== undefined || documentUrl !== undefined;
    if (complete || documentsAdded || instructions !== undefined) {
      const what = [
        complete ? `اكتملت مرحلة "${stage.title}"` : `تحديث في مرحلة "${stage.title}"`,
        documentsAdded ? 'المستندات متاحة في مستندات رحلتي' : '',
        instructions ? 'أُضيفت تعليمات السفر' : '',
      ].filter(Boolean);
      await createAndSendNotification({
        userId: booking.user_id,
        title: complete ? 'تحديث مراحل الرحلة' : 'مستندات وتعليمات جديدة لرحلتك',
        subtitle: `حجزك #${booking.booking_reference}: ${what.join('، ')}`,
        category: 'stage',
        icon: documentsAdded ? 'document-attach-outline' : 'flag-outline',
        iconBg: '#F0FDF4',
        iconColor: '#16A34A',
        data: { type: 'stage_update', stageTitle: stage.title, bookingId: booking.id, bookingRef: booking.booking_reference },
      });
    }
    await activity(
      req,
      complete ? 'stage_completed' : 'stage_updated',
      `${complete ? 'أكمل' : 'حدّث'} مرحلة "${stage.title}"${documentsAdded ? ' مع المستندات' : ''} في الحجز #${booking.booking_reference}`,
      'order',
      booking.id
    );

    res.json({ success: true, message: complete ? 'تم إكمال المرحلة' : 'تم حفظ المرحلة', data: await readOrder(booking.id, req.company.id) });
  } catch (error) {
    console.error('Save stage error:', error);
    res.status(500).json({ error: 'تعذر حفظ المرحلة' });
  }
};

// ───── Clients ─────

export const getCompanyClients = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.phone,
         COUNT(b.id)::int AS bookings_count,
         (ARRAY_AGG((${ORDER_STATE_SQL}) ORDER BY b.created_at DESC))[1] AS last_state
       FROM bookings b
       JOIN packages p ON b.package_id = p.id
       JOIN users u ON b.user_id = u.id
       WHERE p.company_id = $1
       GROUP BY u.id, u.name, u.phone
       ORDER BY MAX(b.created_at) DESC`,
      [req.company.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Company clients error:', error);
    res.status(500).json({ error: 'تعذر جلب العملاء' });
  }
};

export const getCompanyClientDetails = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const { id: companyId, name: companyName } = req.company;
    const clientId = param(req, 'clientId');
    if (!(await isCompanyClient(companyId, companyName, clientId))) {
      res.status(404).json({ error: 'العميل غير موجود' });
      return;
    }

    const client = await pool.query('SELECT id, name, phone, city, created_at FROM users WHERE id = $1', [clientId]);
    const bookings = await pool.query(
      `SELECT ${ORDER_COLUMNS} ${ORDER_FROM} WHERE p.company_id = $1 AND b.user_id = $2 ORDER BY b.created_at DESC`,
      [companyId, clientId]
    );
    const appointments = await pool.query(
      `SELECT id, title, appointment_date, appointment_time, location, notes, status
       FROM interview_appointments WHERE company_name = $1 AND user_id = $2 ORDER BY appointment_date DESC`,
      [companyName, clientId]
    );
    const documents = await pool.query(
      `SELECT d.id, d.traveler_name, d.document_type, d.status, d.valid_until, d.file_url, b.booking_reference
       FROM documents d JOIN bookings b ON d.booking_id = b.id JOIN packages p ON b.package_id = p.id
       WHERE p.company_id = $1 AND b.user_id = $2 ORDER BY d.created_at DESC`,
      [companyId, clientId]
    );
    const note = await pool.query('SELECT note FROM company_client_notes WHERE company_id = $1 AND user_id = $2', [companyId, clientId]);

    res.json({
      success: true,
      data: {
        ...client.rows[0],
        bookings: bookings.rows,
        appointments: appointments.rows,
        documents: documents.rows,
        note: note.rows[0]?.note || '',
      },
    });
  } catch (error) {
    console.error('Company client details error:', error);
    res.status(500).json({ error: 'تعذر جلب بيانات العميل' });
  }
};

export const saveCompanyClientNote = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const clientId = param(req, 'clientId');
    if (!(await isCompanyClient(req.company.id, req.company.name, clientId))) {
      res.status(404).json({ error: 'العميل غير موجود' });
      return;
    }
    await pool.query(
      `INSERT INTO company_client_notes (company_id, user_id, note) VALUES ($1, $2, $3)
       ON CONFLICT (company_id, user_id) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`,
      [req.company.id, clientId, req.body.note]
    );
    await activity(req, 'client_note', 'عدّل ملاحظة الفريق على عميل', 'client', param(req, 'clientId'));
    res.json({ success: true, message: 'تم حفظ الملاحظة' });
  } catch (error) {
    console.error('Client note error:', error);
    res.status(500).json({ error: 'تعذر حفظ الملاحظة' });
  }
};

// ───── Chats ─────

const COMPANY_CHAT_FILTER = `(c.company_id = $1 OR c.company_name = $2) AND c.ticket_number IS NULL`;

const findOwnChat = async (req: CompanyRequest) => {
  const result = await pool.query(
    `SELECT c.*, u.name AS client_name, u.phone AS client_phone
     FROM chats c LEFT JOIN users u ON c.user_id = u.id
     WHERE c.id = $3 AND ${COMPANY_CHAT_FILTER}`,
    [req.company.id, req.company.name, param(req, 'chatId')]
  );
  return result.rows[0] || null;
};

export const getCompanyChats = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.user_id, c.last_message, c.updated_at, u.name AS client_name,
         (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id AND m.sender = 'user' AND m.status = 'sent') AS unread
       FROM chats c LEFT JOIN users u ON c.user_id = u.id
       WHERE ${COMPANY_CHAT_FILTER}
       ORDER BY c.updated_at DESC`,
      [req.company.id, req.company.name]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Company chats error:', error);
    res.status(500).json({ error: 'تعذر جلب المحادثات' });
  }
};

export const startCompanyChat = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const { id: companyId, name: companyName, logo_url: logoUrl, verified } = req.company;
    const { userId } = req.body;
    if (!(await isCompanyClient(companyId, companyName, userId))) {
      res.status(404).json({ error: 'العميل غير موجود' });
      return;
    }
    const existing = await pool.query(
      `SELECT c.id FROM chats c WHERE c.user_id = $3 AND ${COMPANY_CHAT_FILTER} ORDER BY c.updated_at DESC LIMIT 1`,
      [companyId, companyName, userId]
    );
    if (existing.rows[0]) {
      res.json({ success: true, data: { id: existing.rows[0].id } });
      return;
    }
    const chatId = generate16CharId();
    await pool.query(
      `INSERT INTO chats (id, user_id, company_name, company_id, context, last_message, unread_count, avatar, verified)
       VALUES ($1, $2, $3, $4, 'محادثة مع الشركة', '', 0, $5, $6)`,
      [chatId, userId, companyName, companyId, logoUrl, verified]
    );
    res.status(201).json({ success: true, data: { id: chatId } });
  } catch (error) {
    console.error('Start company chat error:', error);
    res.status(500).json({ error: 'تعذر بدء المحادثة' });
  }
};

export const getCompanyChatMessages = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const chat = await findOwnChat(req);
    if (!chat) {
      res.status(404).json({ error: 'المحادثة غير موجودة' });
      return;
    }
    await pool.query(`UPDATE messages SET status = 'read' WHERE chat_id = $1 AND sender = 'user' AND status = 'sent'`, [chat.id]);
    const messages = await pool.query(
      `SELECT id, sender, text, image_uri, time, status, created_at, sent_by_name FROM messages WHERE chat_id = $1 ORDER BY created_at ASC LIMIT 500`,
      [chat.id]
    );
    res.json({
      success: true,
      data: {
        chat: { id: chat.id, user_id: chat.user_id, client_name: chat.client_name, client_phone: chat.client_phone, context: chat.context },
        messages: messages.rows,
      },
    });
  } catch (error) {
    console.error('Company chat messages error:', error);
    res.status(500).json({ error: 'تعذر جلب الرسائل' });
  }
};

export const sendCompanyChatMessage = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const chat = await findOwnChat(req);
    if (!chat) {
      res.status(404).json({ error: 'المحادثة غير موجودة' });
      return;
    }
    const imageUri = await resolveUserUpload(req.body.imageUri, req, req.user!.id);
    if (imageUri === false) {
      res.status(400).json({ error: 'رابط المرفق غير صالح' });
      return;
    }
    const text = req.body.message || '[صورة مرفقة]';
    const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const inserted = await pool.query(
      `INSERT INTO messages (id, chat_id, user_id, company_id, company_name, sender, text, image_uri, time, status, sent_by_name)
       VALUES ($1, $2, $3, $4, $5, 'company', $6, $7, $8, 'received', $9) RETURNING id, sender, text, image_uri, time, status, created_at, sent_by_name`,
      [generate16CharId(), chat.id, chat.user_id, req.company.id, req.company.name, text, imageUri, timeStr, req.actor?.name || null]
    );
    await pool.query(
      `UPDATE chats SET last_message = $1, unread_count = COALESCE(unread_count, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [text, chat.id]
    );
    if (io) {
      const { sent_by_name, ...publicMessage } = inserted.rows[0];
      io.to(`chat_${chat.id}`).emit('receive_message', { ...publicMessage, chat_id: chat.id });
    }

    createAndSendNotification({
      userId: chat.user_id,
      title: `رسالة من ${req.company.name}`,
      subtitle: text,
      category: 'chat',
      icon: 'chatbubble-ellipses-outline',
      iconBg: '#EFF6FF',
      iconColor: '#2563EB',
      data: { type: 'chat_message', chatId: chat.id, companyName: req.company.name },
    }).catch(() => {});

    res.status(201).json({ success: true, data: inserted.rows[0] });
  } catch (error) {
    console.error('Send company message error:', error);
    res.status(500).json({ error: 'تعذر إرسال الرسالة' });
  }
};

// ───── Appointments ─────

const APPOINTMENT_COLUMNS = `a.id, a.user_id, a.chat_id, a.title, a.appointment_date, a.appointment_time, a.location, a.notes, a.status,
  a.status_reason, a.attended_at, u.name AS client_name, u.phone AS client_phone`;

const findOwnAppointment = async (req: CompanyRequest) => {
  const result = await pool.query(
    `SELECT ${APPOINTMENT_COLUMNS} FROM interview_appointments a LEFT JOIN users u ON a.user_id = u.id
     WHERE a.id = $1 AND a.company_name = $2`,
    [param(req, 'id'), req.company.name]
  );
  return result.rows[0] || null;
};

const announceAppointment = async (req: CompanyRequest, appointment: any, title: string, subtitle: string) => {
  if (appointment.chat_id) {
    const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const message = await pool.query(
      `INSERT INTO messages (id, chat_id, user_id, company_id, company_name, sender, text, time, status)
       VALUES ($1, $2, $3, $4, $5, 'company', $6, $7, 'received') RETURNING *`,
      [generate16CharId(), appointment.chat_id, appointment.user_id, req.company.id, req.company.name, `📅 ${subtitle}`, timeStr]
    );
    if (io) {
      io.to(`chat_${appointment.chat_id}`).emit('receive_message', message.rows[0]);
      io.to(`chat_${appointment.chat_id}`).emit('appointment_updated', appointment);
    }
  }
  createAndSendNotification({
    userId: appointment.user_id,
    title,
    subtitle,
    category: 'appointment',
    icon: 'calendar-outline',
    iconBg: '#EFF6FF',
    iconColor: '#2563EB',
    data: { type: 'appointment', appointmentDate: appointment.appointment_date, location: appointment.location },
  }).catch(() => {});
};

export const getCompanyAppointments = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    await expireOverdueAppointmentsThrottled();
    const result = await pool.query(
      `SELECT ${APPOINTMENT_COLUMNS} FROM interview_appointments a LEFT JOIN users u ON a.user_id = u.id
       WHERE a.company_name = $1 ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 300`,
      [req.company.name]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Company appointments error:', error);
    res.status(500).json({ error: 'تعذر جلب المواعيد' });
  }
};

export const createCompanyAppointment = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const { id: companyId, name: companyName, address } = req.company;
    const { userId, appointmentDate, appointmentTime, location, title, notes, chatId } = req.body;
    if (isPastAppointmentTime(appointmentDate, appointmentTime)) {
      res.status(400).json({ error: 'لا يمكن تحديد موعد في وقت مضى' });
      return;
    }
    if (!(await isCompanyClient(companyId, companyName, userId))) {
      res.status(404).json({ error: 'العميل غير موجود' });
      return;
    }

    // A chat id is only accepted when it is this client's chat with this company
    const chat = await pool.query(
      `SELECT c.id FROM chats c WHERE c.user_id = $3 AND ($4::text IS NULL OR c.id = $4) AND ${COMPANY_CHAT_FILTER} ORDER BY c.updated_at DESC LIMIT 1`,
      [companyId, companyName, userId, chatId || null]
    );

    // Not 'confirmed': the customer app offers to confirm or decline anything still awaiting a reply
    const inserted = await pool.query(
      `INSERT INTO interview_appointments (id, user_id, company_name, chat_id, title, appointment_date, appointment_time, location, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') RETURNING *`,
      [
        generate16CharId(), userId, companyName, chat.rows[0]?.id || null, title || 'موعد مقابلة وزيارة',
        appointmentDate, appointmentTime, location || address || 'مقر الشركة', notes || '',
      ]
    );
    // A new proposal replaces any older open one, so the customer only ever has one to answer
    await pool.query(
      `UPDATE interview_appointments SET status = 'cancelled', status_changed_at = NOW(), status_reason = 'تم استبداله بموعد جديد'
       WHERE company_name = $1 AND user_id = $2 AND status IN ('pending', 'suggested', 'confirmed') AND id <> $3`,
      [companyName, userId, inserted.rows[0].id]
    );
    await pool.query(
      `UPDATE bookings b SET appointment_date = $1, appointment_time = $2, appointment_status = 'suggested', appointment_reminder_sent_at = NULL
       FROM packages p WHERE b.package_id = p.id AND p.company_id = $3 AND b.user_id = $4 AND b.status = 'new'`,
      [appointmentDate, appointmentTime, companyId, userId]
    );

    const appointment = inserted.rows[0];
    await announceAppointment(req, appointment, 'موعد مقابلة جديد', `اقترحت ${companyName} موعداً بتاريخ ${appointmentDate} الساعة ${appointmentTime} في ${appointment.location}`);
    await activity(req, 'appointment_created', 'حدد موعداً جديداً مع عميل', 'appointment', appointment?.id);
    res.status(201).json({ success: true, message: 'تم إرسال الموعد للعميل', data: appointment });
  } catch (error) {
    console.error('Create appointment error:', error);
    res.status(500).json({ error: 'تعذر إرسال الموعد' });
  }
};

export const rescheduleCompanyAppointment = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const existing = await findOwnAppointment(req);
    if (!existing) {
      res.status(404).json({ error: 'الموعد غير موجود' });
      return;
    }
    const { appointmentDate, appointmentTime, location, notes } = req.body;
    if (existing.status === 'attended') {
      res.status(409).json({ error: 'حضر العميل هذا الموعد بالفعل، أنشئ موعداً جديداً إذا لزم الأمر' });
      return;
    }
    if (isPastAppointmentTime(appointmentDate, appointmentTime)) {
      res.status(400).json({ error: 'لا يمكن تحديد موعد في وقت مضى' });
      return;
    }
    // A missed or expired appointment can be given a new date; it then waits for the customer's confirmation again
    const updated = await pool.query(
      `UPDATE interview_appointments SET appointment_date = $1, appointment_time = $2, location = COALESCE($3, location),
         notes = COALESCE($4, notes), status = 'pending', status_reason = NULL, status_changed_at = NOW(), reminder_sent_at = NULL
       WHERE id = $5 RETURNING *`,
      [appointmentDate, appointmentTime, location || null, notes ?? null, existing.id]
    );
    await pool.query(
      `UPDATE bookings b SET appointment_date = $1, appointment_time = $2, appointment_status = 'suggested', appointment_reminder_sent_at = NULL
       FROM packages p, companies c
       WHERE b.package_id = p.id AND p.company_id = c.id AND c.name = $3 AND b.user_id = $4 AND b.status = 'new'`,
      [appointmentDate, appointmentTime, req.company.name, existing.user_id]
    );
    await announceAppointment(req, updated.rows[0], 'تغيير موعد المقابلة', `غيّرت ${req.company.name} الموعد إلى ${appointmentDate} الساعة ${appointmentTime}`);
    await activity(req, 'appointment_rescheduled', 'أعاد جدولة موعد مع عميل', 'appointment', param(req, 'id'));
    res.json({ success: true, message: 'تم إرسال الموعد الجديد للعميل', data: updated.rows[0] });
  } catch (error) {
    console.error('Reschedule appointment error:', error);
    res.status(500).json({ error: 'تعذر تغيير الموعد' });
  }
};

// The company confirms the customer came. Also corrects an appointment that was closed as missed by mistake.
export const markCompanyAppointmentAttended = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const existing = await findOwnAppointment(req);
    if (!existing) {
      res.status(404).json({ error: 'الموعد غير موجود' });
      return;
    }
    if (!['pending', 'suggested', 'confirmed', 'missed', 'expired'].includes(existing.status)) {
      res.status(409).json({ error: 'لا يمكن تسجيل الحضور لموعد ملغي أو مرفوض أو مسجل مسبقاً' });
      return;
    }
    if (String(existing.appointment_date || '').slice(0, 10) > localToday()) {
      res.status(400).json({ error: 'لا يمكن تسجيل الحضور قبل يوم الموعد' });
      return;
    }
    const updated = await pool.query(
      `UPDATE interview_appointments SET status = 'attended', attended_at = NOW(), status_changed_at = NOW(), status_reason = NULL
       WHERE id = $1 RETURNING *`,
      [existing.id]
    );
    await pool.query(
      `UPDATE bookings b SET appointment_status = 'attended'
       FROM packages p WHERE b.package_id = p.id AND p.company_id = $1 AND b.user_id = $2 AND b.status = 'new'
         AND b.appointment_status IN ('pending', 'suggested', 'confirmed', 'missed', 'expired')`,
      [req.company.id, existing.user_id]
    );
    if (io && existing.chat_id) io.to(`chat_${existing.chat_id}`).emit('appointment_updated', updated.rows[0]);
    await activity(req, 'appointment_attended', 'سجّل حضور عميل لموعده', 'appointment', param(req, 'id'));
    res.json({ success: true, message: 'تم تسجيل حضور العميل', data: { ...existing, ...updated.rows[0] } });
  } catch (error) {
    console.error('Mark appointment attended error:', error);
    res.status(500).json({ error: 'تعذر تسجيل الحضور' });
  }
};

export const cancelCompanyAppointment = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const existing = await findOwnAppointment(req);
    if (!existing) {
      res.status(404).json({ error: 'الموعد غير موجود' });
      return;
    }
    if (existing.status === 'cancelled') {
      res.status(409).json({ error: 'هذا الموعد ملغي بالفعل' });
      return;
    }
    const updated = await pool.query(
      `UPDATE interview_appointments SET status = 'cancelled', status_changed_at = NOW(), status_reason = $2 WHERE id = $1 RETURNING *`,
      [existing.id, req.body.reason || 'ألغت الشركة الموعد']
    );
    await announceAppointment(req, updated.rows[0], 'إلغاء موعد المقابلة', `ألغت ${req.company.name} موعد ${existing.appointment_date}. السبب: ${req.body.reason}`);
    await activity(req, 'appointment_cancelled', 'ألغى موعداً مع عميل', 'appointment', param(req, 'id'));
    res.json({ success: true, message: 'تم إلغاء الموعد وإبلاغ العميل', data: updated.rows[0] });
  } catch (error) {
    console.error('Cancel appointment error:', error);
    res.status(500).json({ error: 'تعذر إلغاء الموعد' });
  }
};
