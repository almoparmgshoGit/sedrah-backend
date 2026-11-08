import { pool } from '../config/db';
import { io } from '../server';
import { generate16CharId } from './formatId';
import { canAccessModule, getGrantedPermissions } from '../middlewares/permission.middleware';

/*
 * Alerts tell the admins what happened on the platform and what waits for them (a new receipt to review,
 * a company request, a support ticket...). Each alert belongs to one module and reaches only the admins
 * allowed to open that module. Read state is per admin; "handled" is shared, set when anyone acts on it.
 */

export type AlertModule = 'bookings' | 'receipts' | 'companies' | 'store' | 'support' | 'reviews';
export const ALERT_MODULES: AlertModule[] = ['bookings', 'receipts', 'companies', 'store', 'support', 'reviews'];

// The roles allowed into the admin panel (admin.routes authorize list)
export const PANEL_ROLES = ['admin', 'super_admin', 'support', 'moderator'];

export interface AdminAlertInput {
  type: string;
  module: AlertModule;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string | null;
  link?: string;
  // An alert that waits for an admin action stays open until it is handled
  requiresAction?: boolean;
  // Merge into the open alert of the same type and entity instead of adding another one (e.g. ticket replies)
  merge?: boolean;
}

export const adminRoom = (userId: string) => `admin_${userId}`;

const recipientsFor = async (module: AlertModule): Promise<string[]> => {
  const staff = await pool.query(`SELECT id, role FROM users WHERE role = ANY($1)`, [PANEL_ROLES]);
  const allowed: string[] = [];
  for (const row of staff.rows) {
    const granted = await getGrantedPermissions(String(row.id), row.role);
    if (canAccessModule(granted, module)) allowed.push(String(row.id));
  }
  return allowed;
};

const emitTo = async (module: AlertModule, event: string, payload: any) => {
  if (!io) return;
  const ids = await recipientsFor(module);
  if (ids.length > 0) io.to(ids.map(adminRoom)).emit(event, payload);
};

/** Records an alert and pushes it live to the admins who can act on it. Never throws: alerts must not break the action that raised them. */
export const createAdminAlert = async (input: AdminAlertInput): Promise<void> => {
  try {
    const body = input.body?.slice(0, 500) || null;
    let alert: any = null;

    if (input.merge && input.entityId) {
      const merged = await pool.query(
        `UPDATE admin_alerts SET title = $1, body = $2, updated_at = NOW(), occurrences = occurrences + 1
         WHERE id = (
           SELECT id FROM admin_alerts
           WHERE type = $3 AND entity_type = $4 AND entity_id = $5 AND resolved_at IS NULL
           ORDER BY updated_at DESC LIMIT 1
         )
         RETURNING *`,
        [input.title, body, input.type, input.entityType || null, input.entityId]
      );
      alert = merged.rows[0] || null;
      // The new activity makes it unread again for everyone
      if (alert) await pool.query('DELETE FROM admin_alert_reads WHERE alert_id = $1', [alert.id]);
    }

    if (!alert) {
      const created = await pool.query(
        `INSERT INTO admin_alerts (id, type, module, title, body, entity_type, entity_id, link, requires_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          generate16CharId(), input.type, input.module, input.title, body,
          input.entityType || null, input.entityId ? String(input.entityId) : null,
          input.link || null, Boolean(input.requiresAction),
        ]
      );
      alert = created.rows[0];
    }

    await emitTo(input.module, 'admin_alert', { ...alert, is_read: false });
  } catch (err) {
    console.error('Admin alert error:', err);
  }
};

/** Marks the open alerts about an entity as handled, once an admin (or the system) has acted on it. */
export const resolveAdminAlerts = async (
  entityType: string,
  entityId: string,
  resolvedBy?: string | null,
  types?: string[]
): Promise<void> => {
  try {
    const result = await pool.query(
      `UPDATE admin_alerts SET resolved_at = NOW(), resolved_by = $1
       WHERE entity_type = $2 AND entity_id = $3 AND resolved_at IS NULL
         AND ($4::text[] IS NULL OR type = ANY($4))
       RETURNING id, module`,
      [resolvedBy || null, entityType, String(entityId), types && types.length ? types : null]
    );
    const byModule = new Map<AlertModule, string[]>();
    for (const row of result.rows) {
      byModule.set(row.module, [...(byModule.get(row.module) || []), row.id]);
    }
    for (const [module, ids] of byModule) {
      await emitTo(module, 'admin_alert_resolved', { ids });
    }
  } catch (err) {
    console.error('Resolve admin alerts error:', err);
  }
};
