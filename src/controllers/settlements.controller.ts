import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { notifyCompanyTeam } from '../utils/companyAccess';

/*
 * The company collects the customer's payment at its office, so it owes the platform the commission recorded
 * when each receipt was approved. A settlement marks the outstanding commission as paid.
 */

const findCompany = async (rawId: string) => {
  const result = await pool.query('SELECT id, name FROM companies WHERE id = $1 OR public_id = $1', [rawId]);
  return result.rows[0] || null;
};

export const getCompanyStatement = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const company = await findCompany(String(req.params.id));
    if (!company) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }
    const outstanding = await pool.query(
      `SELECT pe.id, pe.commission_amount::float AS commission, pe.created_at, b.booking_reference, b.id AS booking_id,
         COALESCE(b.receipt_verified_amount, b.paid_amount, b.total_price)::float AS amount, b.receipt_reviewed_at
       FROM platform_earnings pe JOIN bookings b ON pe.booking_id = b.id
       WHERE pe.company_id = $1 AND pe.status = 'recorded' AND pe.settlement_id IS NULL
       ORDER BY b.receipt_reviewed_at ASC NULLS FIRST`,
      [company.id]
    );
    const settlements = await pool.query(
      `SELECT id, amount::float AS amount, earnings_count, method, reference, note, created_by, created_at
       FROM company_settlements WHERE company_id = $1 ORDER BY created_at DESC`,
      [company.id]
    );
    const due = outstanding.rows.reduce((sum: number, row: any) => sum + Number(row.commission || 0), 0);
    res.json({
      success: true,
      data: {
        company,
        commission_due: Math.round(due * 100) / 100,
        outstanding: outstanding.rows,
        settlements: settlements.rows,
        settled_total: settlements.rows.reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0),
      },
    });
  } catch (error) {
    console.error('Company statement error:', error);
    res.status(500).json({ error: 'تعذر جلب كشف حساب الشركة' });
  }
};

// Settles every outstanding commission of the company in one payment
export const settleCompanyCommission = async (req: AuthRequest, res: Response): Promise<void> => {
  const company = await findCompany(String(req.params.id));
  if (!company) {
    res.status(404).json({ error: 'الشركة غير موجودة' });
    return;
  }
  const method = typeof req.body?.method === 'string' ? req.body.method.trim().slice(0, 50) : '';
  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim().slice(0, 255) : '';
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';

  const client = await pool.connect();
  let settlement: any;
  try {
    await client.query('BEGIN');
    // Locked so two admins cannot settle the same commissions twice
    const outstanding = await client.query(
      `SELECT id, commission_amount FROM platform_earnings
       WHERE company_id = $1 AND status = 'recorded' AND settlement_id IS NULL FOR UPDATE`,
      [company.id]
    );
    if (outstanding.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      res.status(409).json({ error: 'لا توجد عمولات مستحقة على هذه الشركة' });
      return;
    }
    const amount = outstanding.rows.reduce((sum: number, row: any) => sum + Number(row.commission_amount || 0), 0);
    const settlementId = generate16CharId();
    const created = await client.query(
      `INSERT INTO company_settlements (id, company_id, amount, earnings_count, method, reference, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [settlementId, company.id, amount, outstanding.rows.length, method || null, reference || null, note || null, req.user?.email || 'الإدارة']
    );
    await client.query(
      `UPDATE platform_earnings SET settlement_id = $1, settled_at = NOW() WHERE id = ANY($2::text[])`,
      [settlementId, outstanding.rows.map((row: any) => row.id)]
    );
    await client.query('COMMIT');
    settlement = created.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('Settle commission error:', error);
    res.status(500).json({ error: 'تعذر تسجيل التسوية' });
    return;
  }
  client.release();

  await notifyCompanyTeam(company.id, 'finance.view', {
    title: 'تم تسجيل تسوية العمولات',
    subtitle: `سجّلت إدارة سدرة استلام ${Number(settlement.amount).toLocaleString('en-US')} عن عمولات ${settlement.earnings_count} حجز${reference ? ` (مرجع: ${reference})` : ''}.`,
    category: 'finance',
    icon: 'checkmark-done-outline',
    iconBg: '#ECFDF5',
    iconColor: '#059669',
    data: { type: 'commission_settled', settlementId: settlement.id },
  });
  await logAudit(
    req.user?.email || 'admin',
    'تسوية عمولات شركة',
    `شركة (${company.name}) · ${settlement.amount} عن ${settlement.earnings_count} حجز${reference ? ` · مرجع ${reference}` : ''}`,
    req.ip,
    req.user?.email
  );
  res.status(201).json({ success: true, message: 'تم تسجيل التسوية وإبلاغ الشركة', data: settlement });
};
