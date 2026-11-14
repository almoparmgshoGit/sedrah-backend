import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { canAccessModule, getGrantedPermissions } from '../middlewares/permission.middleware';
import { ALERT_MODULES } from '../utils/adminAlerts';

// The alert modules this admin may see
const visibleModules = async (req: AuthRequest): Promise<string[]> => {
  const granted = await getGrantedPermissions(String(req.user!.id), req.user!.role);
  return ALERT_MODULES.filter((m) => canAccessModule(granted, m));
};

// Unread alerts that someone already handled no longer ask for attention
const UNREAD = `r.alert_id IS NULL AND a.resolved_at IS NULL`;

const STATUS_FILTERS: Record<string, string> = {
  all: 'TRUE',
  unread: UNREAD,
  open: `a.requires_action AND a.resolved_at IS NULL`,
  resolved: `a.resolved_at IS NOT NULL`,
};

export const listAdminAlerts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const modules = await visibleModules(req);
    const requested = typeof req.query.module === 'string' && req.query.module ? [req.query.module] : modules;
    const allowed = requested.filter((m) => modules.includes(m));
    const status = STATUS_FILTERS[String(req.query.status || 'all')] ? String(req.query.status || 'all') : 'all';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100);
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;

    if (allowed.length === 0) {
      res.json({ success: true, data: [], hasMore: false });
      return;
    }

    const result = await pool.query(
      `SELECT a.*, (r.alert_id IS NOT NULL) AS is_read
       FROM admin_alerts a
       LEFT JOIN admin_alert_reads r ON r.alert_id = a.id AND r.admin_id = $1
       WHERE a.module = ANY($2) AND ${STATUS_FILTERS[status]}
         AND ($3::timestamp IS NULL OR a.updated_at < $3::timestamp)
       ORDER BY a.updated_at DESC
       LIMIT $4`,
      [String(req.user!.id), allowed, before, limit + 1]
    );
    res.json({ success: true, data: result.rows.slice(0, limit), hasMore: result.rows.length > limit });
  } catch (error) {
    console.error('List admin alerts error:', error);
    res.status(500).json({ error: 'تعذر جلب التنبيهات' });
  }
};

export const getAdminAlertsSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const modules = await visibleModules(req);
    const byModule: Record<string, { unread: number; open: number }> = {};
    for (const m of modules) byModule[m] = { unread: 0, open: 0 };

    if (modules.length > 0) {
      const result = await pool.query(
        `SELECT a.module,
                COUNT(*) FILTER (WHERE ${UNREAD})::int AS unread,
                COUNT(*) FILTER (WHERE a.requires_action AND a.resolved_at IS NULL)::int AS open
         FROM admin_alerts a
         LEFT JOIN admin_alert_reads r ON r.alert_id = a.id AND r.admin_id = $1
         WHERE a.module = ANY($2) AND (a.resolved_at IS NULL)
         GROUP BY a.module`,
        [String(req.user!.id), modules]
      );
      for (const row of result.rows) byModule[row.module] = { unread: row.unread, open: row.open };
    }

    const totals = Object.values(byModule).reduce((t, m) => ({ unread: t.unread + m.unread, open: t.open + m.open }), { unread: 0, open: 0 });
    res.json({ success: true, data: { ...totals, modules, byModule } });
  } catch (error) {
    console.error('Admin alerts summary error:', error);
    res.status(500).json({ error: 'تعذر جلب ملخص التنبيهات' });
  }
};

export const markAdminAlertRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const modules = await visibleModules(req);
    const alert = await pool.query('SELECT id FROM admin_alerts WHERE id = $1 AND module = ANY($2)', [String(req.params.id), modules]);
    if (alert.rows.length === 0) {
      res.status(404).json({ error: 'التنبيه غير موجود' });
      return;
    }
    await pool.query(
      `INSERT INTO admin_alert_reads (alert_id, admin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [alert.rows[0].id, String(req.user!.id)]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Mark admin alert read error:', error);
    res.status(500).json({ error: 'تعذر تحديث التنبيه' });
  }
};

export const markAllAdminAlertsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const modules = await visibleModules(req);
    const requested = typeof req.body?.module === 'string' && req.body.module ? [req.body.module] : modules;
    const allowed = requested.filter((m: string) => modules.includes(m));
    if (allowed.length > 0) {
      await pool.query(
        `INSERT INTO admin_alert_reads (alert_id, admin_id)
         SELECT a.id, $1::varchar FROM admin_alerts a
         WHERE a.module = ANY($2)
           AND NOT EXISTS (SELECT 1 FROM admin_alert_reads r WHERE r.alert_id = a.id AND r.admin_id = $1::varchar)
         ON CONFLICT DO NOTHING`,
        [String(req.user!.id), allowed]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Mark all admin alerts read error:', error);
    res.status(500).json({ error: 'تعذر تحديث التنبيهات' });
  }
};
