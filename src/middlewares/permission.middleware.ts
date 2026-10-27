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

export const requireModulePermission = (moduleName: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
        return;
      }

      // Super admins and owners always have full access
      if (req.user.role === 'super_admin' || (req.user.role as string) === 'owner' || req.user.email === 'admin@sdra.com') {
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

      // Map module aliases
      const aliases: Record<string, string[]> = {
        users: ['manage_users', 'users'],
        manage_users: ['users', 'manage_users'],
        companies: ['manage_companies', 'companies'],
        manage_companies: ['companies', 'manage_companies'],
        packages: ['manage_packages', 'packages'],
        manage_packages: ['packages', 'manage_packages'],
        bookings: ['manage_bookings', 'bookings'],
        manage_bookings: ['bookings', 'manage_bookings'],
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
      const allowedKeys = [moduleName, ...(aliases[moduleName] || [])];

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
