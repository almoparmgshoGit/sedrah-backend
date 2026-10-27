import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId } from '../utils/formatId';

export const getPermissionGroups = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT pg.*,
      (SELECT COUNT(*) FROM users u WHERE u.permission_group_id = pg.id) as users_count
      FROM permission_groups pg
      ORDER BY pg.created_at DESC
    `);
    const groups = result.rows.map(g => ({
      ...g,
      permissions: typeof g.permissions === 'string' ? JSON.parse(g.permissions) : g.permissions,
    }));
    res.json({ success: true, data: groups });
  } catch (error: any) {
    console.error('Error fetching permission groups:', error);
    res.status(500).json({ error: 'فشل جلب مجموعات الصلاحيات' });
  }
};

export const createPermissionGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, slug, description, permissions } = req.body;
    if (!name || !slug) {
      res.status(400).json({ error: 'الاسم التعريفي واسم الصلاحية البرمجي مطلوبان' });
      return;
    }

    const slugRegex = /^[a-zA-Z0-9_-]+$/;
    if (!slugRegex.test(slug)) {
      res.status(400).json({ error: 'اسم الصلاحية البرمجي يجب أن يكون باللغة الإنجليزية والأرقام والشرطة السفلية فقط بدون مسافات أو حروف عربية' });
      return;
    }

    const permsStr = Array.isArray(permissions) ? JSON.stringify(permissions) : JSON.stringify([]);

    const result = await pool.query(
      `INSERT INTO permission_groups (id, name, slug, description, permissions) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [generate16CharId(), name, slug.toLowerCase(), description || '', permsStr]
    );

    const group = result.rows[0];
    group.permissions = permissions;

    res.status(201).json({ success: true, message: 'تم إنشاء مجموعة الصلاحيات بنجاح', data: group });
  } catch (error: any) {
    console.error('Error creating permission group:', error);
    res.status(500).json({ error: 'فشل إنشاء مجموعة الصلاحيات (قد يكون اسم الصلاحية البرمجي مستخدماً مسبقاً)' });
  }
};

export const updatePermissionGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const groupId = req.params.id;
    const { name, slug, description, permissions } = req.body;

    if (slug) {
      const slugRegex = /^[a-zA-Z0-9_-]+$/;
      if (!slugRegex.test(slug)) {
        res.status(400).json({ error: 'اسم الصلاحية البرمجي يجب أن يكون باللغة الإنجليزية والأرقام والشرطة السفلية فقط بدون مسافات' });
        return;
      }
    }

    const permsStr = permissions ? (Array.isArray(permissions) ? JSON.stringify(permissions) : String(permissions)) : null;

    const result = await pool.query(
      `UPDATE permission_groups SET name = COALESCE($1, name), slug = COALESCE($2, slug), description = COALESCE($3, description), permissions = COALESCE($4, permissions) WHERE id = $5 RETURNING *`,
      [name, slug ? slug.toLowerCase() : null, description, permsStr, groupId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'مجموعة الصلاحيات غير موجودة' });
      return;
    }

    const group = result.rows[0];
    group.permissions = typeof group.permissions === 'string' ? JSON.parse(group.permissions) : group.permissions;

    res.json({ success: true, message: 'تم تحديث مجموعة الصلاحيات بنجاح', data: group });
  } catch (error: any) {
    console.error('Error updating permission group:', error);
    res.status(500).json({ error: 'فشل تحديث مجموعة الصلاحيات' });
  }
};

export const deletePermissionGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const groupId = req.params.id;
    await pool.query('UPDATE users SET permission_group_id = NULL WHERE permission_group_id = $1', [groupId]);
    await pool.query('DELETE FROM permission_groups WHERE id = $1', [groupId]);

    res.json({ success: true, message: 'تم حذف مجموعة الصلاحيات بنجاح' });
  } catch (error: any) {
    console.error('Error deleting permission group:', error);
    res.status(500).json({ error: 'فشل حذف مجموعة الصلاحيات' });
  }
};
