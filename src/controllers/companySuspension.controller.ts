import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { parseIdOrToken } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { notifyCompanyTeam } from '../utils/companyAccess';
import { isCompanySuspended, suspensionInfo } from '../utils/companySuspension';

const MAX_REASON = 1000;

const findCompany = async (rawId: string) => {
  const id = parseIdOrToken(String(rawId || '').trim()).value;
  const result = await pool.query('SELECT * FROM companies WHERE id = $1 OR public_id = $2 LIMIT 1', [id, String(rawId || '').trim()]);
  return result.rows[0] || null;
};

const snapshot = (c: any) => ({
  id: c.id,
  name: c.name,
  status: c.status || 'active',
  suspension_reason: c.suspension_reason || null,
  suspended_at: c.suspended_at || null,
  suspended_until: c.suspended_until || null,
  suspended_by: c.suspended_by || null,
});

const formatDate = (value: any) => {
  try {
    return new Date(value).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return String(value);
  }
};

/**
 * PATCH /admin/companies/:id/suspension
 * body: { action: 'suspend', reason: string, until?: ISO date | null } | { action: 'unsuspend', note?: string }
 */
export const setCompanySuspension = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { action } = req.body || {};
    if (action !== 'suspend' && action !== 'unsuspend') {
      res.status(400).json({ error: 'الإجراء غير صالح' });
      return;
    }

    const company = await findCompany(String(req.params.id));
    if (!company) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }
    const adminEmail = req.user?.email || 'admin@sdra.com';
    const before = snapshot(company);

    if (action === 'suspend') {
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      if (reason.length < 3) {
        res.status(400).json({ error: 'اكتب سبب الإيقاف (3 أحرف على الأقل)' });
        return;
      }
      if (reason.length > MAX_REASON) {
        res.status(400).json({ error: 'سبب الإيقاف طويل جداً' });
        return;
      }

      let until: Date | null = null;
      if (req.body.until) {
        until = new Date(req.body.until);
        if (Number.isNaN(until.getTime())) {
          res.status(400).json({ error: 'تاريخ انتهاء الإيقاف غير صالح' });
          return;
        }
        if (until.getTime() <= Date.now()) {
          res.status(400).json({ error: 'تاريخ انتهاء الإيقاف يجب أن يكون في المستقبل' });
          return;
        }
      }

      const updated = await pool.query(
        `UPDATE companies SET status = 'suspended', suspension_reason = $1, suspended_at = NOW(),
                suspended_until = $2, suspended_by = $3
         WHERE id = $4 RETURNING *`,
        [reason, until, adminEmail, company.id]
      );
      const row = updated.rows[0];

      await logAudit(
        adminEmail,
        isCompanySuspended(company) ? 'تعديل إيقاف شركة' : 'إيقاف شركة',
        `تم إيقاف الشركة "${company.name}"${until ? ` حتى ${formatDate(until)}` : ' حتى إشعار آخر'}. السبب: ${reason}`,
        req.ip,
        req.user?.email || 'المسؤول',
        before,
        snapshot(row)
      );

      notifyCompanyTeam(company.id, '', {
        title: 'تم إيقاف حساب شركتك',
        subtitle: `${until ? `حتى ${formatDate(until)}. ` : ''}السبب: ${reason}`,
        category: 'النظام',
        icon: 'alert-circle',
        iconBg: '#FEE2E2',
        iconColor: '#DC2626',
        data: { type: 'company_suspended', companyId: company.id },
      }).catch((err) => console.error('Failed to notify company team about suspension:', err));

      res.json({ success: true, data: { ...snapshot(row), ...suspensionInfo(row) } });
      return;
    }

    // unsuspend
    if (!isCompanySuspended(company) && (company.status || 'active') !== 'suspended') {
      res.status(409).json({ error: 'الشركة غير موقوفة' });
      return;
    }
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, MAX_REASON) : '';
    const updated = await pool.query(
      `UPDATE companies SET status = 'active', suspension_reason = NULL, suspended_at = NULL,
              suspended_until = NULL, suspended_by = NULL
       WHERE id = $1 RETURNING *`,
      [company.id]
    );
    const row = updated.rows[0];

    await logAudit(
      adminEmail,
      'رفع إيقاف شركة',
      `تم رفع الإيقاف عن الشركة "${company.name}"${note ? `. ملاحظة: ${note}` : ''}`,
      req.ip,
      req.user?.email || 'المسؤول',
      before,
      snapshot(row)
    );

    notifyCompanyTeam(company.id, '', {
      title: 'تم رفع الإيقاف عن شركتك',
      subtitle: note || 'يمكنك الآن استقبال الحجوزات ونشر الباقات من جديد',
      category: 'النظام',
      icon: 'checkmark-circle',
      iconBg: '#DCFCE7',
      iconColor: '#16A34A',
      data: { type: 'company_unsuspended', companyId: company.id },
    }).catch((err) => console.error('Failed to notify company team about unsuspension:', err));

    res.json({ success: true, data: { ...snapshot(row), ...suspensionInfo(row) } });
  } catch (error) {
    console.error('setCompanySuspension error:', error);
    res.status(500).json({ error: 'تعذر تحديث حالة إيقاف الشركة' });
  }
};
