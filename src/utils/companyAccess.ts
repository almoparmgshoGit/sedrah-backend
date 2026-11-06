import { pool } from '../config/db';
import { generate16CharId } from './formatId';
import { createAndSendNotification, NotificationPayload } from './notificationHelper';

/*
 * Who may act for a company: its owner (companies.user_id) with every permission, or an active team member
 * with the permissions of their role. The owner defines the roles; nothing here trusts the client.
 */

export interface PermissionDef {
  key: string;
  label: string;
  description?: string;
}

export interface PermissionGroup {
  key: string;
  label: string;
  permissions: PermissionDef[];
}

export const COMPANY_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'orders',
    label: 'طلبات الحجز',
    permissions: [
      { key: 'orders.view', label: 'عرض طلبات الحجز وتفاصيلها' },
      { key: 'orders.manage', label: 'قبول الطلبات ورفضها وإلغاؤها', description: 'يشمل تذكير العميل بالدفع' },
      { key: 'orders.view_amounts', label: 'رؤية أسعار الحجوزات والمبالغ المدفوعة' },
    ],
  },
  {
    key: 'trips',
    label: 'الرحلات',
    permissions: [
      { key: 'trips.view', label: 'عرض الرحلات والمعتمرين' },
      { key: 'trips.stages', label: 'تحديث مراحل الرحلة', description: 'التأشيرات والتذاكر والسكن وغيرها' },
    ],
  },
  {
    key: 'packages',
    label: 'الباقات',
    permissions: [
      { key: 'packages.view', label: 'عرض الباقات' },
      { key: 'packages.manage', label: 'إضافة الباقات وتعديلها ونشرها وإيقافها' },
      { key: 'packages.delete', label: 'حذف الباقات' },
    ],
  },
  {
    key: 'clients',
    label: 'العملاء',
    permissions: [
      { key: 'clients.view', label: 'عرض العملاء وملفاتهم' },
      { key: 'clients.contact', label: 'رؤية أرقام هواتف العملاء والاتصال بهم' },
      { key: 'clients.notes', label: 'كتابة ملاحظات الفريق على العملاء' },
      { key: 'clients.documents', label: 'عرض مستندات المسافرين', description: 'الجوازات والتأشيرات' },
    ],
  },
  {
    key: 'chats',
    label: 'الرسائل',
    permissions: [
      { key: 'chats.view', label: 'قراءة محادثات العملاء' },
      { key: 'chats.reply', label: 'الرد على العملاء وبدء محادثات' },
    ],
  },
  {
    key: 'appointments',
    label: 'المواعيد',
    permissions: [
      { key: 'appointments.view', label: 'عرض المواعيد' },
      { key: 'appointments.manage', label: 'تحديد المواعيد وتعديلها وإلغاؤها وتسجيل الحضور' },
    ],
  },
  {
    key: 'finance',
    label: 'المالية',
    permissions: [{ key: 'finance.view', label: 'عرض المبيعات والعمولات' }],
  },
  {
    key: 'reviews',
    label: 'التقييمات',
    permissions: [
      { key: 'reviews.view', label: 'عرض تقييمات العملاء' },
      { key: 'reviews.reply', label: 'الرد على التقييمات باسم الشركة' },
    ],
  },
  {
    key: 'company',
    label: 'بيانات الشركة',
    permissions: [
      { key: 'company.profile', label: 'تعديل بيانات الشركة', description: 'الوصف والاتصال والعنوان والشعار وأوقات العمل' },
      { key: 'company.documents', label: 'إدارة المستندات الرسمية للشركة' },
    ],
  },
  {
    key: 'team',
    label: 'فريق العمل',
    permissions: [
      { key: 'team.view', label: 'عرض أعضاء الفريق وأدوارهم' },
      { key: 'team.manage', label: 'إضافة الموظفين وتعديلهم وإيقافهم وإزالتهم' },
      { key: 'team.roles', label: 'إنشاء الأدوار والمسميات وتعديل صلاحياتها' },
      { key: 'team.activity', label: 'عرض سجل نشاط الفريق' },
    ],
  },
];

export const ALL_COMPANY_PERMISSIONS = COMPANY_PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.key));
const PERMISSION_SET = new Set(ALL_COMPANY_PERMISSIONS);

export const cleanPermissions = (input: unknown): string[] => {
  const list = Array.isArray(input) ? input : [];
  return [...new Set(list.map(String).filter((key) => PERMISSION_SET.has(key)))];
};

const parsePermissions = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return cleanPermissions(raw);
  try {
    return cleanPermissions(JSON.parse(String(raw || '[]')));
  } catch {
    return [];
  }
};

// Created once per company, so a new owner starts from sensible roles and edits them freely
const DEFAULT_ROLES: Array<{ name: string; description: string; color: string; permissions: string[] }> = [
  {
    name: 'مدير',
    description: 'إدارة كاملة للعمليات اليومية دون التحكم في الفريق',
    color: '#173D35',
    permissions: ALL_COMPANY_PERMISSIONS.filter((key) => !['team.manage', 'team.roles', 'company.documents'].includes(key)),
  },
  {
    name: 'موظف حجوزات',
    description: 'متابعة الطلبات والرحلات والمواعيد',
    color: '#2563EB',
    permissions: [
      'orders.view', 'orders.manage', 'orders.view_amounts', 'trips.view', 'trips.stages',
      'packages.view', 'clients.view', 'clients.contact', 'clients.notes', 'clients.documents',
      'chats.view', 'chats.reply', 'appointments.view', 'appointments.manage',
    ],
  },
  {
    name: 'خدمة العملاء',
    description: 'الرد على العملاء وتحديد المواعيد',
    color: '#C8A96A',
    permissions: ['orders.view', 'packages.view', 'clients.view', 'clients.contact', 'chats.view', 'chats.reply', 'appointments.view', 'appointments.manage', 'reviews.view'],
  },
  {
    name: 'محاسب',
    description: 'متابعة المدفوعات والمبيعات',
    color: '#7C3AED',
    permissions: ['orders.view', 'orders.view_amounts', 'finance.view', 'packages.view'],
  },
];

export const ensureDefaultRoles = async (companyId: string): Promise<void> => {
  const existing = await pool.query('SELECT 1 FROM company_roles WHERE company_id = $1 LIMIT 1', [companyId]);
  if (existing.rows.length > 0) return;
  for (const role of DEFAULT_ROLES) {
    await pool.query(
      `INSERT INTO company_roles (id, company_id, name, description, color, permissions) VALUES ($1, $2, $3, $4, $5, $6)`,
      [generate16CharId(), companyId, role.name, role.description, role.color, JSON.stringify(role.permissions)]
    );
  }
};

export interface CompanyAccess {
  company: any;
  isOwner: boolean;
  memberId: string | null;
  roleId: string | null;
  roleName: string | null;
  jobTitle: string | null;
  permissions: string[];
}

/**
 * Finds the company this user acts for. Pending ownership and pending invitations addressed to the
 * user's email are claimed here, on the first request after they sign in with that email.
 * Returns null without a company, and { suspended: true } for a member the company suspended.
 */
export const resolveCompanyAccess = async (
  userId: string,
  email: string | null | undefined
): Promise<CompanyAccess | { suspended: true; companyName: string } | null> => {
  const owned = await pool.query(
    `SELECT * FROM companies
     WHERE user_id = $1 OR (user_id IS NULL AND LOWER(pending_owner_email) = LOWER($2))
     ORDER BY created_at ASC LIMIT 1`,
    [userId, email || '']
  );
  if (owned.rows.length > 0) {
    const company = owned.rows[0];
    // File access and every other ownership check rely on user_id, so a pending owner is linked here
    if (!company.user_id) {
      await pool.query('UPDATE companies SET user_id = $1, pending_owner_email = NULL WHERE id = $2', [userId, company.id]);
      company.user_id = userId;
    }
    return { company, isOwner: true, memberId: null, roleId: null, roleName: 'المالك', jobTitle: 'مالك الشركة', permissions: [...ALL_COMPANY_PERMISSIONS] };
  }

  let member = await pool.query(
    `SELECT m.*, r.name AS role_name, r.permissions AS role_permissions
     FROM company_members m LEFT JOIN company_roles r ON m.role_id = r.id
     WHERE m.user_id = $1 LIMIT 1`,
    [userId]
  );

  if (member.rows.length === 0 && email) {
    const invite = await pool.query(
      `UPDATE company_members SET user_id = $1, status = 'active', joined_at = NOW()
       WHERE id = (
         SELECT id FROM company_members
         WHERE user_id IS NULL AND status = 'invited' AND LOWER(invite_email) = LOWER($2)
         ORDER BY created_at ASC LIMIT 1
       )
       RETURNING id, company_id`,
      [userId, email]
    );
    if (invite.rows.length > 0) {
      member = await pool.query(
        `SELECT m.*, r.name AS role_name, r.permissions AS role_permissions
         FROM company_members m LEFT JOIN company_roles r ON m.role_id = r.id WHERE m.id = $1`,
        [invite.rows[0].id]
      );
      await logCompanyActivity(invite.rows[0].company_id, { id: userId, name: email }, 'member_joined', 'انضم إلى فريق العمل', 'member', invite.rows[0].id);
    }
  }

  const row = member.rows[0];
  if (!row) return null;
  const companyRes = await pool.query('SELECT * FROM companies WHERE id = $1', [row.company_id]);
  const company = companyRes.rows[0];
  if (!company) return null;
  if (row.status !== 'active') return { suspended: true, companyName: company.name };

  pool.query('UPDATE company_members SET last_seen_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
  return {
    company,
    isOwner: false,
    memberId: row.id,
    roleId: row.role_id,
    roleName: row.role_name || null,
    jobTitle: row.job_title || null,
    permissions: parsePermissions(row.role_permissions),
  };
};

// The owner and every active member whose role grants the permission
export const companyTeamUserIds = async (companyId: string, permission?: string): Promise<string[]> => {
  const owner = await pool.query('SELECT user_id FROM companies WHERE id = $1', [companyId]);
  const ids = new Set<string>();
  if (owner.rows[0]?.user_id) ids.add(String(owner.rows[0].user_id));
  const members = await pool.query(
    `SELECT m.user_id, r.permissions FROM company_members m LEFT JOIN company_roles r ON m.role_id = r.id
     WHERE m.company_id = $1 AND m.status = 'active' AND m.user_id IS NOT NULL`,
    [companyId]
  );
  for (const row of members.rows) {
    if (!permission || parsePermissions(row.permissions).includes(permission)) ids.add(String(row.user_id));
  }
  return [...ids];
};

export const notifyCompanyTeam = async (
  companyId: string | null | undefined,
  permission: string,
  payload: Omit<NotificationPayload, 'userId'>,
  exceptUserId?: string | null
): Promise<void> => {
  if (!companyId) return;
  const ids = await companyTeamUserIds(companyId, permission);
  for (const userId of ids) {
    if (exceptUserId && String(userId) === String(exceptUserId)) continue;
    await createAndSendNotification({ ...payload, userId });
  }
};

export const logCompanyActivity = async (
  companyId: string,
  actor: { id?: string | null; name?: string | null },
  action: string,
  details: string,
  targetType?: string,
  targetId?: string | null
): Promise<void> => {
  try {
    await pool.query(
      `INSERT INTO company_activity (id, company_id, actor_user_id, actor_name, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [generate16CharId(), companyId, actor.id || null, actor.name || null, action, targetType || null, targetId ? String(targetId) : null, details.slice(0, 1000)]
    );
  } catch (error) {
    console.error('Company activity log error:', error);
  }
};

// SQL fragment: is $userParam the owner or an active member of company alias `co`
export const isCompanyTeamSql = (companyAlias: string, userParam: string) =>
  `(${companyAlias}.user_id = ${userParam} OR EXISTS (SELECT 1 FROM company_members cm WHERE cm.company_id = ${companyAlias}.id AND cm.user_id = ${userParam} AND cm.status = 'active'))`;
