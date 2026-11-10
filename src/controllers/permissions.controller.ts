import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { safeParseArray } from '../middlewares/permission.middleware';
import { disconnectUserSockets } from '../server';

// Only a super admin may change the group that grants their own access
const editsOwnGroup = async (req: AuthRequest, groupId: string): Promise<boolean> => {
  if (req.user?.role === 'super_admin') return false;
  const self = await pool.query('SELECT permission_group_id FROM users WHERE id = $1', [req.user?.id]);
  return !!self.rows[0]?.permission_group_id && String(self.rows[0].permission_group_id) === String(groupId);
};

// Members of a changed group sign in again, so their sessions pick up the new permissions
const revokeSessionsOf = async (userIds: string[]) => {
  if (userIds.length === 0) return;
  await pool.query('UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = ANY($1::text[]) AND is_revoked = FALSE', [userIds]);
  for (const userId of userIds) {
    try {
      disconnectUserSockets(userId);
    } catch (e) {
      console.error('Disconnect sockets error:', e);
    }
  }
};

const groupMemberIds = async (groupId: string): Promise<string[]> => {
  const members = await pool.query('SELECT id FROM users WHERE permission_group_id = $1', [groupId]);
  return members.rows.map((row: any) => String(row.id));
};

const sameSet = (a: string[], b: string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
};

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
    group.permissions = Array.isArray(permissions) ? permissions : [];

    await logAudit(
      req.user?.email || 'admin',
      'إنشاء مجموعة صلاحيات',
      `المجموعة ${group.name} (${group.slug})`,
      req.ip,
      req.user?.email,
      null,
      { name: group.name, slug: group.slug, permissions: group.permissions }
    );

    res.status(201).json({ success: true, message: 'تم إنشاء مجموعة الصلاحيات بنجاح', data: group });
  } catch (error: any) {
    console.error('Error creating permission group:', error);
    res.status(500).json({ error: 'فشل إنشاء مجموعة الصلاحيات (قد يكون اسم الصلاحية البرمجي مستخدماً مسبقاً)' });
  }
};

export const updatePermissionGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const groupId = String(req.params.id);
    const { name, slug, description, permissions } = req.body;

    if (slug) {
      const slugRegex = /^[a-zA-Z0-9_-]+$/;
      if (!slugRegex.test(slug)) {
        res.status(400).json({ error: 'اسم الصلاحية البرمجي يجب أن يكون باللغة الإنجليزية والأرقام والشرطة السفلية فقط بدون مسافات' });
        return;
      }
    }

    if (await editsOwnGroup(req, groupId)) {
      res.status(403).json({ error: 'لا يمكنك تعديل مجموعة الصلاحيات التي تنتمي إليها' });
      return;
    }

    const beforeRes = await pool.query('SELECT * FROM permission_groups WHERE id = $1', [groupId]);
    const before = beforeRes.rows[0];
    if (!before) {
      res.status(404).json({ error: 'مجموعة الصلاحيات غير موجودة' });
      return;
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

    const beforePerms = safeParseArray(before.permissions);
    const afterPerms = safeParseArray(group.permissions);
    const permissionsChanged = !sameSet(beforePerms, afterPerms);
    if (permissionsChanged) {
      await revokeSessionsOf(await groupMemberIds(groupId));
    }

    await logAudit(
      req.user?.email || 'admin',
      'تعديل مجموعة صلاحيات',
      `المجموعة ${group.name} (${group.slug})${permissionsChanged ? ' · تم تغيير الصلاحيات وإنهاء جلسات أعضائها' : ''}`,
      req.ip,
      req.user?.email,
      { name: before.name, slug: before.slug, description: before.description, permissions: beforePerms },
      { name: group.name, slug: group.slug, description: group.description, permissions: afterPerms }
    );

    res.json({ success: true, message: 'تم تحديث مجموعة الصلاحيات بنجاح', data: group });
  } catch (error: any) {
    console.error('Error updating permission group:', error);
    res.status(500).json({ error: 'فشل تحديث مجموعة الصلاحيات' });
  }
};

export const deletePermissionGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const groupId = String(req.params.id);
    if (await editsOwnGroup(req, groupId)) {
      res.status(403).json({ error: 'لا يمكنك حذف مجموعة الصلاحيات التي تنتمي إليها' });
      return;
    }

    const beforeRes = await pool.query('SELECT * FROM permission_groups WHERE id = $1', [groupId]);
    const before = beforeRes.rows[0];
    if (!before) {
      res.status(404).json({ error: 'مجموعة الصلاحيات غير موجودة' });
      return;
    }
    const memberIds = await groupMemberIds(groupId);

    await pool.query('UPDATE users SET permission_group_id = NULL WHERE permission_group_id = $1', [groupId]);
    await pool.query('DELETE FROM permission_groups WHERE id = $1', [groupId]);
    await revokeSessionsOf(memberIds);

    await logAudit(
      req.user?.email || 'admin',
      'حذف مجموعة صلاحيات',
      `المجموعة ${before.name} (${before.slug}) · ${memberIds.length} عضو`,
      req.ip,
      req.user?.email,
      { name: before.name, slug: before.slug, description: before.description, permissions: safeParseArray(before.permissions) },
      null
    );

    res.json({ success: true, message: 'تم حذف مجموعة الصلاحيات بنجاح' });
  } catch (error: any) {
    console.error('Error deleting permission group:', error);
    res.status(500).json({ error: 'فشل حذف مجموعة الصلاحيات' });
  }
};
