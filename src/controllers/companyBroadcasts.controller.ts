import { Response } from 'express';
import { pool } from '../config/db';
import { generate16CharId } from '../utils/formatId';
import { sendPushToUsers } from '../utils/pushNotification';
import { logCompanyActivity } from '../utils/companyAccess';
import type { CompanyRequest } from './company.controller';

/*
 * Notifications the company writes itself (meeting point, changed date, departure time...) and sends either to
 * everyone booked on one of its packages or to the client of a single booking. They land in the customer app.
 */

// Keeps a team member from flooding travelers by mistake
const HOURLY_LIMIT = 30;

const AUDIENCE_SQL: Record<'active' | 'confirmed', string> = {
  active: `b.status NOT IN ('cancelled', 'rejected')`,
  confirmed: `b.status IN ('confirmed', 'completed')`,
};

const packageRecipients = async (companyId: string, packageId: string, audience: 'active' | 'confirmed'): Promise<string[]> => {
  const result = await pool.query(
    `SELECT DISTINCT b.user_id FROM bookings b JOIN packages p ON b.package_id = p.id
     WHERE p.id = $1 AND p.company_id = $2 AND b.user_id IS NOT NULL AND ${AUDIENCE_SQL[audience]}`,
    [packageId, companyId]
  );
  return result.rows.map((row) => String(row.user_id));
};

const findOwnPackage = async (companyId: string, packageId: string) => {
  const result = await pool.query('SELECT id, title FROM packages WHERE id = $1 AND company_id = $2', [packageId, companyId]);
  return result.rows[0] || null;
};

// How many people each audience reaches, shown before sending
export const getBroadcastAudience = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const packageId = String(req.query.packageId || '');
    if (!(await findOwnPackage(req.company.id, packageId))) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    const [active, confirmed] = await Promise.all([
      packageRecipients(req.company.id, packageId, 'active'),
      packageRecipients(req.company.id, packageId, 'confirmed'),
    ]);
    res.json({ success: true, data: { active: active.length, confirmed: confirmed.length } });
  } catch (error) {
    console.error('Broadcast audience error:', error);
    res.status(500).json({ error: 'تعذر حساب عدد المستلمين' });
  }
};

export const listBroadcasts = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const packageId = req.query.packageId ? String(req.query.packageId) : null;
    const bookingId = req.query.bookingId ? String(req.query.bookingId) : null;
    const result = await pool.query(
      `SELECT cb.id, cb.package_id, cb.booking_id, cb.audience, cb.title, cb.message, cb.recipients_count,
              cb.sent_by_name, cb.created_at, p.title AS package_title,
              COALESCE(b.customer_name, u.name) AS client_name, b.booking_reference
       FROM company_broadcasts cb
       LEFT JOIN packages p ON p.id = cb.package_id
       LEFT JOIN bookings b ON b.id = cb.booking_id
       LEFT JOIN users u ON u.id = b.user_id
       WHERE cb.company_id = $1
         AND ($2::text IS NULL OR cb.package_id = $2)
         AND ($3::text IS NULL OR cb.booking_id = $3)
       ORDER BY cb.created_at DESC LIMIT 100`,
      [req.company.id, packageId, bookingId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('List broadcasts error:', error);
    res.status(500).json({ error: 'تعذر جلب الإشعارات المرسلة' });
  }
};

export const sendBroadcast = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const { target, packageId, bookingId, audience, title, message } = req.body;
    const companyId = req.company.id;

    const recent = await pool.query(
      `SELECT COUNT(*)::int AS total FROM company_broadcasts WHERE company_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [companyId]
    );
    if (recent.rows[0].total >= HOURLY_LIMIT) {
      res.status(429).json({ error: 'تم إرسال عدد كبير من الإشعارات خلال الساعة الأخيرة، حاول لاحقاً' });
      return;
    }

    let recipients: string[] = [];
    let pkgId: string | null = null;
    let bkgId: string | null = null;
    let targetLabel = '';

    if (target === 'package') {
      const pkg = await findOwnPackage(companyId, packageId);
      if (!pkg) {
        res.status(404).json({ error: 'الباقة غير موجودة' });
        return;
      }
      pkgId = pkg.id;
      recipients = await packageRecipients(companyId, pkg.id, audience);
      targetLabel = `المشتركين في باقة "${pkg.title}"`;
    } else {
      // Scoped through the package, so another company's booking ids cannot be reached
      const result = await pool.query(
        `SELECT b.id, b.user_id, b.booking_reference, b.package_id FROM bookings b JOIN packages p ON b.package_id = p.id
         WHERE b.id = $1 AND p.company_id = $2`,
        [bookingId, companyId]
      );
      const booking = result.rows[0];
      if (!booking) {
        res.status(404).json({ error: 'الطلب غير موجود' });
        return;
      }
      bkgId = booking.id;
      pkgId = booking.package_id;
      recipients = booking.user_id ? [String(booking.user_id)] : [];
      targetLabel = `عميل الحجز #${booking.booking_reference}`;
    }

    if (recipients.length === 0) {
      res.status(400).json({ error: 'لا يوجد مسافرون لإرسال الإشعار إليهم' });
      return;
    }

    const broadcastId = generate16CharId();
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, subtitle, category, icon, icon_bg, icon_color, is_read, audience)
       SELECT r.id, r.user_id, $3, $4, 'trip', 'megaphone-outline', 'bg-amber-50 border-amber-100', '#B45309', false, 'customer'
       FROM unnest($1::text[], $2::text[]) AS r(id, user_id)`,
      [recipients.map(() => generate16CharId()), recipients, title, message]
    );
    await pool.query(
      `INSERT INTO company_broadcasts (id, company_id, package_id, booking_id, audience, title, message, recipients_count, sent_by_user_id, sent_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [broadcastId, companyId, pkgId, bkgId, target === 'booking' ? 'single' : audience, title, message, recipients.length, req.actor?.id || null, req.actor?.name || null]
    );

    // The notification is already saved; a failed push only means the phone does not ring
    sendPushToUsers(
      recipients,
      title,
      message,
      { type: 'company_broadcast', category: 'trip', broadcastId, packageId: pkgId, bookingId: bkgId, companyName: req.company.name },
      'customer'
    ).catch((error) => console.error('Broadcast push error:', error));

    await logCompanyActivity(companyId, req.actor || {}, 'broadcast', `أرسل إشعار "${title}" إلى ${targetLabel} (${recipients.length})`, target, bkgId || pkgId);

    res.json({
      success: true,
      data: { id: broadcastId, recipients_count: recipients.length },
      message: recipients.length === 1 ? 'تم إرسال الإشعار' : `تم إرسال الإشعار إلى ${recipients.length} مسافر`,
    });
  } catch (error) {
    console.error('Send broadcast error:', error);
    res.status(500).json({ error: 'تعذر إرسال الإشعار' });
  }
};
