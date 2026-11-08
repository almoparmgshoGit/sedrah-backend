import { Response, NextFunction } from 'express';
import { AuthRequest } from './security.middleware';
import { pool } from '../config/db';

export function safeParseArray(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(s => String(s).trim());

  let str = String(input).trim();

  while ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      return parsed.map(s => String(s).trim());
    }
  } catch (e) {}

  str = str.replace(/^\{|\}$|^\[|\]$/g, '');
  return str
    .split(',')
    .map(s => s.replace(/["']/g, '').trim())
    .filter(Boolean);
}

// Each module also accepts the older permission names stored on some accounts and groups
const MODULE_ALIASES: Record<string, string[]> = {
  users: ['manage_users', 'users'],
  manage_users: ['users', 'manage_users'],
  companies: ['manage_companies', 'companies'],
  manage_companies: ['companies', 'manage_companies'],
  packages: ['manage_packages', 'packages'],
  manage_packages: ['packages', 'manage_packages'],
  bookings: ['manage_bookings', 'bookings'],
  manage_bookings: ['bookings', 'manage_bookings'],
  receipts: ['manage_receipts', 'receipts'],
  manage_receipts: ['receipts', 'manage_receipts'],
  // Existing groups with the notifications permission keep their support desk access
  support: ['support', 'notifications', 'send_notifications'],
  notifications: ['send_notifications', 'notifications'],
  send_notifications: ['notifications', 'send_notifications'],
  reviews: ['manage_reviews', 'reviews'],
  manage_reviews: ['reviews', 'manage_reviews'],
  admins: ['manage_admins', 'admins'],
  manage_admins: ['admins', 'manage_admins'],
  audit_logs: ['view_audit_logs', 'audit_logs'],
  view_audit_logs: ['audit_logs', 'view_audit_logs'],
  settings: ['manage_settings', 'settings'],
  manage_settings: ['settings', 'manage_settings'],
};

const FULL_ACCESS_ROLES = ['super_admin', 'owner'];

const moduleKeys = (moduleName: string): string[] => [moduleName, ...(MODULE_ALIASES[moduleName] || [])];

/** Every permission a staff account holds, directly or through its group; null for roles with full access. */
export const getGrantedPermissions = async (userId: string, role?: string | null): Promise<Set<string> | null> => {
  if (role && FULL_ACCESS_ROLES.includes(role)) return null;
  const result = await pool.query(
    `SELECT u.permissions, g.permissions AS group_permissions
     FROM users u LEFT JOIN permission_groups g ON g.id = u.permission_group_id
     WHERE u.id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return new Set();
  return new Set([...safeParseArray(row.permissions), ...safeParseArray(row.group_permissions)]);
};

/** Same rule as requireModulePermission, for permissions already loaded with getGrantedPermissions. */
export const canAccessModule = (granted: Set<string> | null, moduleName: string): boolean =>
  granted === null || moduleKeys(moduleName).some((k) => granted.has(k));

export const requireModulePermission = (moduleName: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
        return;
      }

      // Super admins and owners always have full access
      if (req.user.role === 'super_admin' || (req.user.role as string) === 'owner') {
        return next();
      }

      // Check user permissions directly or via permission group
      const userRes = await pool.query(
        'SELECT permissions, permission_group_id FROM users WHERE id = $1',
        [req.user.id]
      );

      if (userRes.rows.length === 0) {
        res.status(403).json({ error: 'غير مصرح بالوصول' });
        return;
      }

      const user = userRes.rows[0];
      const permissions = safeParseArray(user.permissions);

      const allowedKeys = moduleKeys(moduleName);

      // Check if user has direct permission
      if (allowedKeys.some(k => permissions.includes(k))) {
        return next();
      }

      // If user belongs to a permission group, check group permissions
      if (user.permission_group_id) {
        const groupRes = await pool.query(
          'SELECT permissions FROM permission_groups WHERE id = $1',
          [user.permission_group_id]
        );
        if (groupRes.rows.length > 0) {
          const groupPerms = safeParseArray(groupRes.rows[0].permissions);
          if (allowedKeys.some(k => groupPerms.includes(k))) {
            return next();
          }
        }
      }

      res.status(403).json({ error: `ليس لديك صلاحية الوصول إلى وحدة: ${moduleName}` });
    } catch (error: any) {
      console.error('Permission middleware error:', error);
      res.status(500).json({ error: 'حدث خطأ أثناء التحقق من الصلاحيات' });
    }
  };
};
