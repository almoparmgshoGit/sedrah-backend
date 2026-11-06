import { Response } from 'express';
import { pool } from '../config/db';
import { generate16CharId } from '../utils/formatId';
import { createAndSendNotification } from '../utils/notificationHelper';
import { sendPlatformEmail } from '../utils/mailer';
import { cleanPermissions, COMPANY_PERMISSION_GROUPS, ensureDefaultRoles, logCompanyActivity } from '../utils/companyAccess';
import type { CompanyRequest } from './company.controller';

/*
 * Company team management. Every rule that matters is enforced here, not in the app:
 * - nobody grants a permission they do not hold themselves (the owner holds all of them)
 * - nobody changes their own membership, and the owner cannot be changed or removed
 * - a person belongs to at most one company
 */

const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];

const param = (req: CompanyRequest, name: string) => String(req.params[name] || '');

const parsePermissions = (raw: unknown): string[] => {
  try {
    return cleanPermissions(Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]')));
  } catch {
    return [];
  }
};

const holds = (req: CompanyRequest, permissions: string[]) =>
  Boolean(req.access?.isOwner) || permissions.every((key) => req.access!.permissions.includes(key));

const log = (req: CompanyRequest, action: string, details: string, targetType: string, targetId?: string | null) =>
  logCompanyActivity(req.company.id, req.actor || {}, action, details, targetType, targetId);

const readRole = async (companyId: string, roleId: string) => {
  const result = await pool.query('SELECT * FROM company_roles WHERE id = $1 AND company_id = $2', [roleId, companyId]);
  return result.rows[0] ? { ...result.rows[0], permissions: parsePermissions(result.rows[0].permissions) } : null;
};

const readMember = async (companyId: string, memberId: string) => {
  const result = await pool.query(
    `SELECT m.*, r.permissions AS role_permissions, r.name AS role_name, u.name AS user_name, u.email AS user_email
     FROM company_members m
     LEFT JOIN company_roles r ON m.role_id = r.id
     LEFT JOIN users u ON m.user_id = u.id
     WHERE m.id = $1 AND m.company_id = $2`,
    [memberId, companyId]
  );
  return result.rows[0] ? { ...result.rows[0], role_permissions: parsePermissions(result.rows[0].role_permissions) } : null;
};

const memberLabel = (member: any) => member.user_name || member.user_email || member.invite_email || 'عضو';

// ───── Permissions catalogue ─────

export const getPermissionCatalogue = async (req: CompanyRequest, res: Response): Promise<void> => {
  res.json({ success: true, data: COMPANY_PERMISSION_GROUPS });
};

// ───── Members ─────

export const listMembers = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.company.id;
    await ensureDefaultRoles(companyId);
    const owner = await pool.query('SELECT id, name, email, phone FROM users WHERE id = $1', [req.company.user_id]);
    const members = await pool.query(
      `SELECT m.id, m.user_id, m.invite_email, m.role_id, m.job_title, m.status, m.joined_at, m.last_seen_at, m.created_at,
         r.name AS role_name, r.color AS role_color, u.name, u.email, u.phone, inv.name AS invited_by_name
       FROM company_members m
       LEFT JOIN company_roles r ON m.role_id = r.id
       LEFT JOIN users u ON m.user_id = u.id
       LEFT JOIN users inv ON m.invited_by = inv.id
       WHERE m.company_id = $1
       ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END, m.created_at ASC`,
      [companyId]
    );
    const ownerRow = owner.rows[0];
    res.json({
      success: true,
      data: {
        owner: ownerRow ? { user_id: ownerRow.id, name: ownerRow.name, email: ownerRow.email, phone: ownerRow.phone } : null,
        members: members.rows.map((row: any) => ({ ...row, email: row.email || row.invite_email })),
      },
    });
  } catch (error) {
    console.error('List team members error:', error);
    res.status(500).json({ error: 'تعذر جلب فريق العمل' });
  }
};

export const addMember = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const companyId = req.company.id;
    const email = String(req.body.email).trim().toLowerCase();
    const jobTitle = String(req.body.jobTitle || '').trim() || null;

    const role = await readRole(companyId, String(req.body.roleId));
    if (!role) {
      res.status(400).json({ error: 'الدور غير موجود' });
      return;
    }
    if (!holds(req, role.permissions)) {
      res.status(403).json({ error: 'لا يمكنك منح دور يحتوي على صلاحيات لا تملكها' });
      return;
    }

    const userRes = await pool.query('SELECT id, name, email, role, status FROM users WHERE LOWER(email) = $1', [email]);
    const user = userRes.rows[0];
    if (user) {
      if (String(user.id) === String(req.company.user_id)) {
        res.status(409).json({ error: 'هذا البريد هو بريد مالك الشركة' });
        return;
      }
      if (STAFF_ROLES.includes(user.role)) {
        res.status(409).json({ error: 'لا يمكن إضافة حساب من إدارة المنصة إلى فريق شركة' });
        return;
      }
      if (user.status === 'banned' || user.status === 'inactive') {
        res.status(409).json({ error: 'هذا الحساب غير مفعّل على المنصة' });
        return;
      }
      const owns = await pool.query('SELECT 1 FROM companies WHERE user_id = $1 LIMIT 1', [user.id]);
      if (owns.rows.length > 0) {
        res.status(409).json({ error: 'صاحب هذا البريد يملك شركة أخرى على المنصة' });
        return;
      }
      const elsewhere = await pool.query('SELECT company_id FROM company_members WHERE user_id = $1', [user.id]);
      if (elsewhere.rows.length > 0) {
        res.status(409).json({
          error: elsewhere.rows[0].company_id === companyId ? 'هذا الموظف عضو في الفريق بالفعل' : 'صاحب هذا البريد عضو في فريق شركة أخرى',
        });
        return;
      }
    }
    const pending = await pool.query(
      'SELECT 1 FROM company_members WHERE company_id = $1 AND LOWER(invite_email) = $2',
      [companyId, email]
    );
    if (pending.rows.length > 0) {
      res.status(409).json({ error: 'تمت دعوة هذا البريد بالفعل' });
      return;
    }

    // An existing account joins at once; a new email waits until someone signs up with it
    const memberId = generate16CharId();
    await pool.query(
      `INSERT INTO company_members (id, company_id, user_id, invite_email, role_id, job_title, status, invited_by, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [memberId, companyId, user?.id || null, email, role.id, jobTitle, user ? 'active' : 'invited', req.user!.id, user ? new Date() : null]
    );

    if (user) {
      await createAndSendNotification({
        userId: user.id,
        title: `انضممت إلى فريق ${req.company.name}`,
        subtitle: `أضافك ${req.actor?.name || 'مسؤول الشركة'} بدور "${role.name}". افتح تطبيق سدرة للشركات وسجّل الدخول بحسابك.`,
        category: 'team',
        icon: 'people-outline',
        iconBg: '#ECFDF5',
        iconColor: '#059669',
        data: { type: 'team_added', companyId },
      });
    }
    sendPlatformEmail({
      to: email,
      templateKey: 'company_team_invite',
      variables: { company_name: req.company.name } as any,
      fallbackSubject: `دعوة للانضمام إلى فريق ${req.company.name} على سدرة`,
      fallbackHtml: `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8">
        <p>مرحبًا،</p>
        <p>دعاك ${req.actor?.name || 'مسؤول'} للانضمام إلى فريق <b>${req.company.name}</b> على منصة سدرة بدور <b>${role.name}</b>.</p>
        <p>حمّل تطبيق <b>سدرة للشركات</b> و${user ? 'سجّل الدخول بحسابك الحالي' : 'أنشئ حسابًا بهذا البريد نفسه'} (${email})، وستجد الشركة جاهزة.</p>
      </div>`,
    }).catch(() => {});

    await log(req, 'member_added', `${user ? 'أضاف' : 'دعا'} ${user?.name || email} بدور "${role.name}"`, 'member', memberId);
    res.status(201).json({
      success: true,
      message: user ? 'تمت إضافة الموظف إلى الفريق' : 'تم إرسال الدعوة، وسينضم الموظف عند إنشاء حسابه بهذا البريد',
      data: { id: memberId, status: user ? 'active' : 'invited' },
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      res.status(409).json({ error: 'هذا البريد مضاف إلى فريق بالفعل' });
      return;
    }
    console.error('Add team member error:', error);
    res.status(500).json({ error: 'تعذر إضافة الموظف' });
  }
};

// Shared checks before changing or removing someone else's membership
const loadManageableMember = async (req: CompanyRequest, res: Response) => {
  const member = await readMember(req.company.id, param(req, 'id'));
  if (!member) {
    res.status(404).json({ error: 'العضو غير موجود' });
    return null;
  }
  if (member.user_id && String(member.user_id) === String(req.user!.id)) {
    res.status(403).json({ error: 'لا يمكنك تعديل عضويتك بنفسك' });
    return null;
  }
  if (!holds(req, member.role_permissions)) {
    res.status(403).json({ error: 'لا يمكنك تعديل عضو لديه صلاحيات أعلى من صلاحياتك' });
    return null;
  }
  return member;
};

export const updateMember = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const member = await loadManageableMember(req, res);
    if (!member) return;

    const changes: string[] = [];
    let roleId = member.role_id;
    if (req.body.roleId !== undefined && req.body.roleId !== member.role_id) {
      const role = await readRole(req.company.id, String(req.body.roleId));
      if (!role) {
        res.status(400).json({ error: 'الدور غير موجود' });
        return;
      }
      if (!holds(req, role.permissions)) {
        res.status(403).json({ error: 'لا يمكنك منح دور يحتوي على صلاحيات لا تملكها' });
        return;
      }
      roleId = role.id;
      changes.push(`الدور إلى "${role.name}"`);
    }
    let status = member.status;
    if (req.body.status !== undefined && req.body.status !== member.status) {
      if (member.status === 'invited') {
        res.status(409).json({ error: 'لم ينضم هذا الموظف بعد، يمكنك إلغاء الدعوة بدلاً من ذلك' });
        return;
      }
      status = req.body.status;
      changes.push(status === 'suspended' ? 'إيقاف الحساب' : 'إعادة التفعيل');
    }
    const jobTitle = req.body.jobTitle !== undefined ? String(req.body.jobTitle).trim() || null : member.job_title;
    if (jobTitle !== member.job_title) changes.push(`المسمى الوظيفي إلى "${jobTitle || '-'}"`);

    if (changes.length === 0) {
      res.json({ success: true, message: 'لا توجد تغييرات' });
      return;
    }
    await pool.query('UPDATE company_members SET role_id = $1, status = $2, job_title = $3 WHERE id = $4', [roleId, status, jobTitle, member.id]);

    if (member.user_id) {
      await createAndSendNotification({
        userId: member.user_id,
        title: status === 'suspended' ? `تم إيقاف حسابك في ${req.company.name}` : `تحديث عضويتك في ${req.company.name}`,
        subtitle: `تم تغيير ${changes.join('، ')}`,
        category: 'team',
        icon: status === 'suspended' ? 'pause-circle-outline' : 'people-outline',
        iconBg: '#F8F5EE',
        iconColor: '#C8A96A',
        data: { type: 'team_updated', companyId: req.company.id },
      });
    }
    await log(req, 'member_updated', `عدّل عضوية ${memberLabel(member)}: ${changes.join('، ')}`, 'member', member.id);
    res.json({ success: true, message: 'تم حفظ التعديلات' });
  } catch (error) {
    console.error('Update team member error:', error);
    res.status(500).json({ error: 'تعذر تعديل العضو' });
  }
};

export const removeMember = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const member = await loadManageableMember(req, res);
    if (!member) return;
    await pool.query('DELETE FROM company_members WHERE id = $1', [member.id]);
    if (member.user_id) {
      await createAndSendNotification({
        userId: member.user_id,
        title: `لم تعد عضوًا في فريق ${req.company.name}`,
        subtitle: 'أُزيل حسابك من فريق الشركة.',
        category: 'team',
        icon: 'person-remove-outline',
        iconBg: '#FEF2F2',
        iconColor: '#DC2626',
        data: { type: 'team_removed', companyId: req.company.id },
      });
    }
    await log(req, member.status === 'invited' ? 'invite_cancelled' : 'member_removed', `${member.status === 'invited' ? 'ألغى دعوة' : 'أزال'} ${memberLabel(member)}`, 'member', member.id);
    res.json({ success: true, message: member.status === 'invited' ? 'تم إلغاء الدعوة' : 'تمت إزالة العضو من الفريق' });
  } catch (error) {
    console.error('Remove team member error:', error);
    res.status(500).json({ error: 'تعذر إزالة العضو' });
  }
};

export const resendInvite = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const member = await loadManageableMember(req, res);
    if (!member) return;
    if (member.status !== 'invited' || !member.invite_email) {
      res.status(409).json({ error: 'انضم هذا الموظف بالفعل' });
      return;
    }
    const sent = await sendPlatformEmail({
      to: member.invite_email,
      templateKey: 'company_team_invite',
      variables: { company_name: req.company.name } as any,
      fallbackSubject: `تذكير: دعوة للانضمام إلى فريق ${req.company.name} على سدرة`,
      fallbackHtml: `<div dir="rtl" style="font-family:Tahoma,Arial;line-height:1.8">
        <p>مرحبًا،</p>
        <p>ما زالت دعوتك للانضمام إلى فريق <b>${req.company.name}</b> على منصة سدرة قائمة.</p>
        <p>حمّل تطبيق <b>سدرة للشركات</b> وأنشئ حسابًا بالبريد ${member.invite_email}.</p>
      </div>`,
    });
    res.json({ success: true, message: sent ? 'تم إرسال الدعوة مرة أخرى' : 'تعذر إرسال البريد حاليًا، أبلغ الموظف بإنشاء حساب بهذا البريد' });
  } catch (error) {
    console.error('Resend invite error:', error);
    res.status(500).json({ error: 'تعذر إرسال الدعوة' });
  }
};

// A member may leave on their own; the owner cannot leave their company
export const leaveTeam = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    if (req.access?.isOwner || !req.access?.memberId) {
      res.status(409).json({ error: 'مالك الشركة لا يمكنه مغادرة الفريق' });
      return;
    }
    await pool.query('DELETE FROM company_members WHERE id = $1', [req.access.memberId]);
    await log(req, 'member_left', `غادر ${req.actor?.name || 'عضو'} الفريق`, 'member', req.access.memberId);
    res.json({ success: true, message: 'غادرت فريق الشركة' });
  } catch (error) {
    console.error('Leave team error:', error);
    res.status(500).json({ error: 'تعذر مغادرة الفريق' });
  }
};

// ───── Roles ─────

export const listRoles = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    await ensureDefaultRoles(req.company.id);
    const roles = await pool.query(
      `SELECT r.*, (SELECT COUNT(*)::int FROM company_members m WHERE m.role_id = r.id) AS members_count
       FROM company_roles r WHERE r.company_id = $1 ORDER BY r.created_at ASC`,
      [req.company.id]
    );
    res.json({ success: true, data: roles.rows.map((row: any) => ({ ...row, permissions: parsePermissions(row.permissions) })) });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ error: 'تعذر جلب الأدوار' });
  }
};

export const createRole = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const permissions = cleanPermissions(req.body.permissions);
    if (!holds(req, permissions)) {
      res.status(403).json({ error: 'لا يمكنك إنشاء دور بصلاحيات لا تملكها' });
      return;
    }
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM company_roles WHERE company_id = $1', [req.company.id]);
    if (count.rows[0].total >= 30) {
      res.status(409).json({ error: 'وصلت إلى الحد الأقصى لعدد الأدوار (30)' });
      return;
    }
    const duplicate = await pool.query('SELECT 1 FROM company_roles WHERE company_id = $1 AND LOWER(name) = LOWER($2)', [req.company.id, req.body.name]);
    if (duplicate.rows.length > 0) {
      res.status(409).json({ error: 'يوجد دور بهذا الاسم بالفعل' });
      return;
    }
    const id = generate16CharId();
    const created = await pool.query(
      `INSERT INTO company_roles (id, company_id, name, description, color, permissions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, req.company.id, req.body.name, req.body.description || null, req.body.color || null, JSON.stringify(permissions), req.user!.id]
    );
    await log(req, 'role_created', `أنشأ الدور "${req.body.name}" (${permissions.length} صلاحية)`, 'role', id);
    res.status(201).json({ success: true, message: 'تم إنشاء الدور', data: { ...created.rows[0], permissions, members_count: 0 } });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ error: 'تعذر إنشاء الدور' });
  }
};

export const updateRole = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const role = await readRole(req.company.id, param(req, 'id'));
    if (!role) {
      res.status(404).json({ error: 'الدور غير موجود' });
      return;
    }
    const permissions: string[] = req.body.permissions !== undefined ? cleanPermissions(req.body.permissions) : role.permissions;
    // Editing a role touches both what it had and what it gets, so both must be within the editor's reach
    if (!holds(req, role.permissions) || !holds(req, permissions)) {
      res.status(403).json({ error: 'لا يمكنك تعديل دور يحتوي على صلاحيات لا تملكها' });
      return;
    }
    if (!req.access?.isOwner && req.access?.roleId === role.id) {
      res.status(403).json({ error: 'لا يمكنك تعديل الدور الذي تحمله' });
      return;
    }
    const name = req.body.name !== undefined ? req.body.name : role.name;
    if (name !== role.name) {
      const duplicate = await pool.query('SELECT 1 FROM company_roles WHERE company_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3', [req.company.id, name, role.id]);
      if (duplicate.rows.length > 0) {
        res.status(409).json({ error: 'يوجد دور بهذا الاسم بالفعل' });
        return;
      }
    }
    const updated = await pool.query(
      `UPDATE company_roles SET name = $1, description = $2, color = $3, permissions = $4, updated_at = NOW() WHERE id = $5 RETURNING *`,
      [
        name,
        req.body.description !== undefined ? req.body.description || null : role.description,
        req.body.color !== undefined ? req.body.color || null : role.color,
        JSON.stringify(permissions),
        role.id,
      ]
    );
    const added = permissions.filter((key) => !role.permissions.includes(key)).length;
    const removed = role.permissions.filter((key: string) => !permissions.includes(key)).length;
    await log(req, 'role_updated', `عدّل الدور "${name}"${added || removed ? ` (+${added} / -${removed} صلاحية)` : ''}`, 'role', role.id);
    res.json({ success: true, message: 'تم حفظ الدور', data: { ...updated.rows[0], permissions } });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ error: 'تعذر تعديل الدور' });
  }
};

export const deleteRole = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const role = await readRole(req.company.id, param(req, 'id'));
    if (!role) {
      res.status(404).json({ error: 'الدور غير موجود' });
      return;
    }
    if (!holds(req, role.permissions)) {
      res.status(403).json({ error: 'لا يمكنك حذف دور يحتوي على صلاحيات لا تملكها' });
      return;
    }
    const members = await pool.query('SELECT COUNT(*)::int AS total FROM company_members WHERE role_id = $1', [role.id]);
    const moveTo = req.query.moveTo ? String(req.query.moveTo) : null;
    if (members.rows[0].total > 0) {
      const target = moveTo ? await readRole(req.company.id, moveTo) : null;
      if (!target || target.id === role.id) {
        res.status(409).json({ error: `يحمل هذا الدور ${members.rows[0].total} عضو، اختر دورًا آخر لنقلهم إليه`, code: 'ROLE_IN_USE' });
        return;
      }
      if (!holds(req, target.permissions)) {
        res.status(403).json({ error: 'لا يمكنك نقل الأعضاء إلى دور بصلاحيات لا تملكها' });
        return;
      }
      await pool.query('UPDATE company_members SET role_id = $1 WHERE role_id = $2', [target.id, role.id]);
    }
    await pool.query('DELETE FROM company_roles WHERE id = $1', [role.id]);
    await log(req, 'role_deleted', `حذف الدور "${role.name}"`, 'role', role.id);
    res.json({ success: true, message: 'تم حذف الدور' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ error: 'تعذر حذف الدور' });
  }
};

// ───── Activity ─────

export const listActivity = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = 30;
    const actor = req.query.actor ? String(req.query.actor) : null;
    const result = await pool.query(
      `SELECT id, actor_user_id, actor_name, action, target_type, target_id, details, created_at
       FROM company_activity
       WHERE company_id = $1 AND ($2::text IS NULL OR actor_user_id = $2)
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.company.id, actor, limit + 1, (page - 1) * limit]
    );
    res.json({
      success: true,
      data: result.rows.slice(0, limit),
      pagination: { page, limit, has_more: result.rows.length > limit },
    });
  } catch (error) {
    console.error('Company activity error:', error);
    res.status(500).json({ error: 'تعذر جلب سجل النشاط' });
  }
};
