import { Response } from 'express';
import { pool } from '../config/db';
import { io } from '../server';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId } from '../utils/formatId';
import { createAndSendNotification } from '../utils/notificationHelper';
import { logAudit } from '../utils/auditLogger';
import { notifyCompanyTeam } from '../utils/companyAccess';
import { createAdminAlert, resolveAdminAlerts } from '../utils/adminAlerts';

/*
 * Only the customer uploads a payment receipt, after paying at the company's office. The company sees the
 * receipt of its own bookings, but only an admin with the "receipts" permission approves or rejects it, since approval confirms the
 * booking and records the platform commission.
 */

type ReceiptActor = { id: string | null; name: string; type: 'customer' | 'admin' | 'system' };

const addHistory = async (
  db: { query: (text: string, params?: any[]) => Promise<any> },
  bookingId: string,
  action: 'submitted' | 'approved' | 'rejected' | 'reopened',
  actor: ReceiptActor,
  fields: { receiptUrl?: string | null; paidAmount?: number | null; verifiedAmount?: number | null; reason?: string | null; note?: string | null } = {}
) => {
  await db.query(
    `INSERT INTO receipt_reviews (id, booking_id, action, receipt_url, paid_amount, verified_amount, reason, note, actor_id, actor_name, actor_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      generate16CharId(),
      bookingId,
      action,
      fields.receiptUrl || null,
      fields.paidAmount ?? null,
      fields.verifiedAmount ?? null,
      fields.reason || null,
      fields.note || null,
      actor.id,
      actor.name,
      actor.type,
    ]
  );
};

const companyOwnerOf = async (bookingId: string): Promise<{ userId: string | null; companyId: string | null; companyName: string | null }> => {
  const result = await pool.query(
    `SELECT c.user_id, c.id, c.name FROM bookings b JOIN packages p ON b.package_id = p.id JOIN companies c ON p.company_id = c.id WHERE b.id = $1`,
    [bookingId]
  );
  return { userId: result.rows[0]?.user_id || null, companyId: result.rows[0]?.id || null, companyName: result.rows[0]?.name || null };
};

/**
 * Puts the customer's receipt into the admin review queue. The caller has already checked that the booking
 * is the customer's, that it awaits payment and that the file is theirs; this records the submission.
 */
export const submitReceiptForReview = async (
  booking: any,
  receiptUrl: string,
  paidAmount: number | null,
  customer: { id: string; name: string }
): Promise<any> => {
  const actor: ReceiptActor = { id: customer.id, name: customer.name, type: 'customer' };
  const result = await pool.query(
    `UPDATE bookings
     SET status = 'receipt_review',
         receipt_url = $1,
         receipt_approved = FALSE,
         receipt_status = 'pending',
         rejection_reason = NULL,
         paid_amount = COALESCE($3, paid_amount),
         receipt_submitted_at = NOW(),
         receipt_reviewed_at = NULL,
         receipt_reviewed_by = NULL,
         receipt_verified_amount = NULL,
         receipt_uploaded_by = 'customer'
     WHERE id = $2
     RETURNING *`,
    [receiptUrl, booking.id, paidAmount]
  );
  const updated = result.rows[0];

  // Stage 2 stays current while the platform reviews the receipt; it completes on approval
  await pool.query(
    `UPDATE trip_stages SET status = 'current', document_url = $1,
       subtitle = 'تم رفع الإيصال وهو قيد مراجعة إدارة سدرة'
     WHERE booking_id = $2 AND stage_order = 2`,
    [receiptUrl, booking.id]
  );
  await pool.query(
    `UPDATE trip_stages SET status = 'pending' WHERE booking_id = $1 AND stage_order > 2 AND status = 'current'`,
    [booking.id]
  );

  await addHistory(pool, booking.id, 'submitted', actor, { receiptUrl, paidAmount });

  // The company follows along; it cannot act on the receipt
  const owner = await companyOwnerOf(booking.id);
  if (owner.companyId) {
    await notifyCompanyTeam(owner.companyId, 'orders.view', {
      title: 'إيصال دفع جديد',
      subtitle: `رفع العميل إيصال الدفع للحجز #${updated.booking_reference}، وهو الآن قيد مراجعة إدارة سدرة.`,
      category: 'booking',
      icon: 'receipt-outline',
      iconBg: '#EFF6FF',
      iconColor: '#2563EB',
      data: { type: 'receipt_uploaded', bookingId: updated.id, bookingRef: updated.booking_reference },
    });
  }

  await createAdminAlert({
    type: 'receipt_submitted',
    module: 'receipts',
    title: 'إيصال دفع جديد بانتظار المراجعة',
    body: `${customer.name || 'عميل'} رفع إيصال الحجز #${updated.booking_reference}${owner.companyName ? ` لدى ${owner.companyName}` : ''}`,
    entityType: 'booking',
    entityId: updated.id,
    link: `/receipts?id=${updated.id}`,
    requiresAction: true,
  });

  if (io) io.to('staff').emit('receipt_submitted', { id: updated.id, booking_reference: updated.booking_reference });
  return updated;
};

const RECEIPT_COLUMNS = `
  b.id, b.booking_reference, b.status, b.receipt_url, b.receipt_status, b.receipt_approved, b.rejection_reason,
  b.allow_retry, b.paid_amount, b.total_price, b.commission_amount, b.commission_method_used, b.commission_rate_used,
  b.receipt_submitted_at, b.receipt_reviewed_at, b.receipt_reviewed_by, b.receipt_verified_amount, b.receipt_admin_note,
  b.receipt_uploaded_by, b.travelers_count, b.children_count, b.room_type, b.created_at,
  COALESCE(b.customer_name, u.name) AS customer_name, COALESCE(b.customer_phone, u.phone) AS customer_phone, u.email AS customer_email,
  p.id AS package_id, p.title AS package_title, p.departure_date,
  c.id AS company_id, c.name AS company_name, c.phone AS company_phone, c.logo_url AS company_logo,
  (SELECT COUNT(*)::int FROM receipt_reviews r WHERE r.booking_id = b.id AND r.action = 'submitted') AS attempts,
  CASE
    WHEN b.status = 'receipt_review' THEN 'pending'
    WHEN b.receipt_status = 'approved' AND b.receipt_approved THEN 'approved'
    WHEN b.receipt_status = 'rejected' THEN 'rejected'
    ELSE COALESCE(b.receipt_status, 'pending')
  END AS review_state`;

const RECEIPT_FROM = `
  FROM bookings b
  LEFT JOIN users u ON b.user_id = u.id
  LEFT JOIN packages p ON b.package_id = p.id
  LEFT JOIN companies c ON p.company_id = c.id`;

const REVIEW_STATE_FILTERS: Record<string, string> = {
  pending: `b.status = 'receipt_review'`,
  approved: `b.receipt_status = 'approved' AND b.receipt_approved = TRUE`,
  rejected: `b.receipt_status = 'rejected' AND b.status <> 'receipt_review'`,
  all: 'TRUE',
};

export const listReceipts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const state = String(req.query.status || 'pending');
    const filter = REVIEW_STATE_FILTERS[state] || REVIEW_STATE_FILTERS.pending;
    const companyId = req.query.companyId ? String(req.query.companyId) : null;

    const rows = await pool.query(
      `SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM}
       WHERE b.receipt_url IS NOT NULL AND b.receipt_url <> '' AND ${filter}
         AND ($1::text IS NULL OR c.id = $1)
       ORDER BY ${state === 'pending' ? 'b.receipt_submitted_at ASC NULLS LAST' : 'COALESCE(b.receipt_reviewed_at, b.receipt_submitted_at) DESC NULLS LAST'}
       LIMIT 500`,
      [companyId]
    );

    const summary = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE b.status = 'receipt_review')::int AS pending,
         COUNT(*) FILTER (WHERE b.status = 'receipt_review' AND b.receipt_submitted_at < NOW() - INTERVAL '24 hours')::int AS overdue,
         COUNT(*) FILTER (WHERE b.receipt_status = 'approved' AND b.receipt_reviewed_at::date = CURRENT_DATE)::int AS approved_today,
         COUNT(*) FILTER (WHERE b.receipt_status = 'rejected' AND b.receipt_reviewed_at::date = CURRENT_DATE)::int AS rejected_today,
         COALESCE(SUM(b.commission_amount) FILTER (WHERE b.status = 'receipt_review'), 0)::float AS pending_commission
       FROM bookings b
       WHERE b.receipt_url IS NOT NULL AND b.receipt_url <> ''`
    );

    res.json({ success: true, data: rows.rows, summary: summary.rows[0] });
  } catch (error) {
    console.error('List receipts error:', error);
    res.status(500).json({ error: 'تعذر جلب الإيصالات' });
  }
};

export const getReceipt = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id);
    const result = await pool.query(`SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM} WHERE b.id = $1 OR b.booking_reference = $1`, [id]);
    const receipt = result.rows[0];
    if (!receipt || !receipt.receipt_url) {
      res.status(404).json({ error: 'لا يوجد إيصال لهذا الحجز' });
      return;
    }

    const history = await pool.query(
      `SELECT id, action, receipt_url, paid_amount, verified_amount, reason, note, actor_name, actor_type, created_at
       FROM receipt_reviews WHERE booking_id = $1 ORDER BY created_at DESC`,
      [receipt.id]
    );

    // The same file attached to another booking is a strong sign of a reused receipt
    const filename = String(receipt.receipt_url).split('/').pop() || '';
    const duplicates = filename
      ? await pool.query(
          `SELECT b.id, b.booking_reference, b.status FROM bookings b
           WHERE b.id <> $1 AND strpos(b.receipt_url, $2) > 0`,
          [receipt.id, `/${filename}`]
        )
      : { rows: [] };

    res.json({ success: true, data: { ...receipt, history: history.rows, duplicates: duplicates.rows } });
  } catch (error) {
    console.error('Get receipt error:', error);
    res.status(500).json({ error: 'تعذر جلب تفاصيل الإيصال' });
  }
};

const parseAmount = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 99999999 ? Math.round(amount * 100) / 100 : NaN;
};

export const reviewReceipt = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const body = req.body || {};
  // Older admin screens sent 'approved' and 'pending'
  const action = body.action === 'approved' ? 'approve' : body.action === 'pending' || body.action === 'review' ? 'reopen' : body.action;
  const reason = typeof body.rejectionReason === 'string' ? body.rejectionReason.trim().slice(0, 500) : typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  const verifiedAmount = parseAmount(body.verifiedAmount);

  if (!['approve', 'reject', 'reopen'].includes(action)) {
    res.status(400).json({ error: 'إجراء غير معروف' });
    return;
  }
  if (Number.isNaN(verifiedAmount)) {
    res.status(400).json({ error: 'المبلغ المستلم غير صالح' });
    return;
  }
  if (action === 'reject' && reason.length < 3) {
    res.status(400).json({ error: 'اكتب سبب الرفض ليظهر للعميل' });
    return;
  }
  if (action === 'reopen' && reason.length < 3) {
    res.status(400).json({ error: 'اكتب سبب إعادة فتح المراجعة' });
    return;
  }

  const adminRes = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user!.id]);
  const admin = adminRes.rows[0] || { id: req.user!.id, name: req.user!.email, email: req.user!.email };
  const actor: ReceiptActor = { id: String(admin.id), name: admin.name || admin.email || 'الإدارة', type: 'admin' };

  const client = await pool.connect();
  let booking: any;
  try {
    await client.query('BEGIN');
    // Locked so two admins cannot approve the same receipt, or approve while another rejects
    const locked = await client.query('SELECT * FROM bookings WHERE id = $1 OR booking_reference = $1 FOR UPDATE', [id]);
    const current = locked.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'الحجز غير موجود' });
      return;
    }
    if (!current.receipt_url || !String(current.receipt_url).trim()) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'لا يوجد إيصال مرفوع لهذا الحجز' });
      return;
    }
    if ((action === 'approve' || action === 'reject') && current.status !== 'receipt_review') {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'تمت مراجعة هذا الإيصال بالفعل، حدّث الصفحة' });
      return;
    }
    if (action === 'reopen' && (current.status === 'receipt_review' || current.status === 'completed')) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: current.status === 'completed' ? 'لا يمكن إعادة فتح إيصال رحلة مكتملة' : 'الإيصال قيد المراجعة بالفعل' });
      return;
    }

    if (action === 'approve') {
      const updated = await client.query(
        `UPDATE bookings
         SET status = 'confirmed', receipt_approved = TRUE, receipt_status = 'approved', rejection_reason = NULL,
             receipt_reviewed_at = NOW(), receipt_reviewed_by = $2, receipt_verified_amount = $3, receipt_admin_note = NULLIF($4, '')
         WHERE id = $1 RETURNING *`,
        [current.id, actor.name, verifiedAmount ?? current.paid_amount ?? current.total_price, note]
      );
      booking = updated.rows[0];
      // Approval is the final confirmation, so the receipt and confirmation stages complete together
      await client.query(
        `UPDATE trip_stages SET status = 'completed' WHERE booking_id = $1 AND stage_order IN (1, 2, 3)`,
        [booking.id]
      );
      await client.query(
        `UPDATE trip_stages SET subtitle = 'اعتمدت إدارة سدرة الإيصال' WHERE booking_id = $1 AND stage_order = 2`,
        [booking.id]
      );
      await client.query(
        `UPDATE trip_stages SET status = 'current' WHERE booking_id = $1 AND stage_order = 4 AND status = 'pending'`,
        [booking.id]
      );
      const pkg = await client.query('SELECT company_id FROM packages WHERE id = $1', [booking.package_id]);
      if (pkg.rows[0]?.company_id) {
        await client.query(
          `INSERT INTO platform_earnings (id, booking_id, company_id, commission_amount, status)
           VALUES ($1, $2, $3, $4, 'recorded')
           ON CONFLICT (booking_id) DO UPDATE SET commission_amount = EXCLUDED.commission_amount, status = 'recorded'`,
          [generate16CharId(), booking.id, pkg.rows[0].company_id, booking.commission_amount || 0]
        );
      }
      await addHistory(client, booking.id, 'approved', actor, { receiptUrl: booking.receipt_url, verifiedAmount: booking.receipt_verified_amount, note });
    } else if (action === 'reject') {
      const allowRetry = body.allowRetry !== false && body.allowRetry !== 'false';
      const updated = await client.query(
        `UPDATE bookings
         SET status = $2, receipt_approved = FALSE, receipt_status = 'rejected', rejection_reason = $3, allow_retry = $4,
             receipt_reviewed_at = NOW(), receipt_reviewed_by = $5, receipt_admin_note = NULLIF($6, ''),
             cancellation_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancellation_reason END,
             cancelled_by = CASE WHEN $2 = 'cancelled' THEN 'admin' ELSE cancelled_by END
         WHERE id = $1 RETURNING *`,
        // 'new' with a completed visit stage is the "awaiting payment" state, which lets the customer upload again
        [current.id, allowRetry ? 'new' : 'cancelled', reason, allowRetry, actor.name, note]
      );
      booking = updated.rows[0];
      await client.query(
        allowRetry
          ? `UPDATE trip_stages SET status = CASE WHEN stage_order = 2 THEN 'current' ELSE 'pending' END,
               subtitle = CASE WHEN stage_order = 2 THEN 'رُفض الإيصال، يرجى رفع إيصال صحيح' ELSE subtitle END
             WHERE booking_id = $1 AND stage_order >= 2`
          : `UPDATE trip_stages SET status = 'cancelled' WHERE booking_id = $1 AND status <> 'completed'`,
        [booking.id]
      );
      await client.query(`UPDATE platform_earnings SET status = 'cancelled' WHERE booking_id = $1`, [booking.id]);
      await addHistory(client, booking.id, 'rejected', actor, { receiptUrl: booking.receipt_url, reason, note });
    } else {
      const updated = await client.query(
        `UPDATE bookings
         SET status = 'receipt_review', receipt_approved = FALSE, receipt_status = 'pending', rejection_reason = NULL,
             receipt_reviewed_at = NULL, receipt_reviewed_by = NULL, receipt_verified_amount = NULL
         WHERE id = $1 RETURNING *`,
        [current.id]
      );
      booking = updated.rows[0];
      await client.query(
        `UPDATE trip_stages SET status = CASE WHEN stage_order = 2 THEN 'current' WHEN stage_order = 1 THEN status ELSE 'pending' END
         WHERE booking_id = $1 AND stage_order >= 1`,
        [booking.id]
      );
      await client.query(`UPDATE platform_earnings SET status = 'cancelled' WHERE booking_id = $1`, [booking.id]);
      await addHistory(client, booking.id, 'reopened', actor, { receiptUrl: booking.receipt_url, reason, note });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('Review receipt error:', error);
    res.status(500).json({ error: 'تعذر حفظ مراجعة الإيصال' });
    return;
  }
  client.release();

  const owner = await companyOwnerOf(booking.id);
  const ref = booking.booking_reference;
  if (action === 'approve') {
    await createAndSendNotification({
      userId: booking.user_id,
      title: 'تم اعتماد إيصال الدفع',
      subtitle: `اعتمدت إدارة سدرة إيصال الدفع لحجزك #${ref} وتم تأكيد الحجز.`,
      category: 'booking',
      icon: 'checkmark-circle-outline',
      iconBg: '#ECFDF5',
      iconColor: '#059669',
      data: { type: 'receipt_approved', bookingId: booking.id, bookingRef: ref },
    });
    if (owner.companyId) {
      await notifyCompanyTeam(owner.companyId, 'orders.view', {
        title: 'تم تأكيد حجز',
        subtitle: `اعتمدت إدارة سدرة إيصال الحجز #${ref}، والحجز مؤكد الآن. يمكنك متابعة مراحل الرحلة.`,
        category: 'booking',
        icon: 'checkmark-circle-outline',
        iconBg: '#ECFDF5',
        iconColor: '#059669',
        data: { type: 'receipt_approved', bookingId: booking.id, bookingRef: ref },
      });
    }
  } else if (action === 'reject') {
    const retry = booking.status !== 'cancelled';
    await createAndSendNotification({
      userId: booking.user_id,
      title: 'رفض إيصال الدفع',
      subtitle: retry
        ? `تعذر اعتماد إيصال الدفع لحجزك #${ref}. السبب: ${reason}. يرجى رفع إيصال صحيح.`
        : `تم رفض إيصال الدفع وإغلاق الحجز #${ref}. السبب: ${reason}`,
      category: 'booking',
      icon: 'alert-circle-outline',
      iconBg: '#FEF2F2',
      iconColor: '#DC2626',
      data: { type: 'receipt_rejected', bookingId: booking.id, bookingRef: ref, reason },
    });
    if (owner.companyId) {
      await notifyCompanyTeam(owner.companyId, 'orders.view', {
        title: retry ? 'رُفض إيصال حجز' : 'أُغلق حجز بعد رفض الإيصال',
        subtitle: `رفضت إدارة سدرة إيصال الحجز #${ref}. السبب: ${reason}${retry ? '. بانتظار إيصال جديد من العميل.' : ''}`,
        category: 'booking',
        icon: 'alert-circle-outline',
        iconBg: '#FEF2F2',
        iconColor: '#DC2626',
        data: { type: 'receipt_rejected', bookingId: booking.id, bookingRef: ref, reason },
      });
    }
  } else if (owner.companyId) {
    await notifyCompanyTeam(owner.companyId, 'orders.view', {
      title: 'إعادة مراجعة إيصال',
      subtitle: `أعادت إدارة سدرة فتح مراجعة إيصال الحجز #${ref}. السبب: ${reason}`,
      category: 'booking',
      icon: 'refresh-outline',
      iconBg: '#FFFBEB',
      iconColor: '#D97706',
      data: { type: 'receipt_reopened', bookingId: booking.id, bookingRef: ref },
    });
  }

  const labels: Record<string, string> = { approve: 'اعتماد إيصال دفع', reject: 'رفض إيصال دفع', reopen: 'إعادة فتح مراجعة إيصال' };
  await logAudit(
    admin.email,
    labels[action],
    `الحجز #${ref}${reason ? ` · السبب: ${reason}` : ''}${verifiedAmount ? ` · المبلغ المستلم: ${verifiedAmount}` : ''}`,
    req.ip,
    admin.name,
    null,
    { status: booking.status, receipt_status: booking.receipt_status, commission_amount: booking.commission_amount }
  );

  // A reopened receipt goes back to the review queue; an approved or rejected one is handled
  if (action === 'reopen') {
    await createAdminAlert({
      type: 'receipt_submitted',
      module: 'receipts',
      title: 'إيصال أُعيد للمراجعة',
      body: `أعاد ${admin.name || admin.email} فتح مراجعة إيصال الحجز #${ref}`,
      entityType: 'booking',
      entityId: booking.id,
      link: `/receipts?id=${booking.id}`,
      requiresAction: true,
    });
  } else {
    await resolveAdminAlerts('booking', booking.id, admin.name || admin.email, ['receipt_submitted']);
  }

  if (io) io.to('staff').emit('receipt_reviewed', { id: booking.id, action });
  const messages: Record<string, string> = {
    approve: 'تم اعتماد الإيصال وتأكيد الحجز وتسجيل العمولة',
    reject: booking.status === 'cancelled' ? 'تم رفض الإيصال وإغلاق الحجز' : 'تم رفض الإيصال وإبلاغ العميل بإعادة الرفع',
    reopen: 'أُعيد الإيصال إلى قائمة المراجعة',
  };
  res.json({ success: true, message: messages[action], data: booking });
};
