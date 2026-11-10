import { pool } from '../config/db';
import { createAndSendNotification } from './notificationHelper';

// Returns why this user cannot own the company, or null when they can.
// A person belongs to one company, so an owner or employee elsewhere is refused.
export const ownerConflict = async (company: any, ownerId: string): Promise<string | null> => {
  const ownedRes = await pool.query('SELECT name FROM companies WHERE user_id = $1 AND id != $2', [ownerId, company.id]);
  if (ownedRes.rows.length > 0) return `هذا المستخدم مرتبط بالفعل بشركة: ${ownedRes.rows[0].name}`;

  const memberRes = await pool.query(
    'SELECT c.name, m.company_id FROM company_members m JOIN companies c ON m.company_id = c.id WHERE m.user_id = $1',
    [ownerId]
  );
  if (memberRes.rows.length > 0 && memberRes.rows[0].company_id !== company.id) {
    return `هذا المستخدم موظف في فريق شركة: ${memberRes.rows[0].name}`;
  }
  return null;
};

// Call after the company's user_id has changed
export const afterOwnerChange = async (company: any, previousOwner: string | null, ownerId: string | null): Promise<void> => {
  // Promoted from employee to owner of the same company
  if (ownerId) await pool.query('DELETE FROM company_members WHERE user_id = $1 AND company_id = $2', [ownerId, company.id]);

  if (previousOwner && previousOwner !== String(ownerId || '')) {
    await createAndSendNotification({
      userId: previousOwner,
      title: 'لم تعد مالكاً للشركة',
      subtitle: `فكّت إدارة سدرة ربط حسابك بشركة ${company.name}. تواصل مع الدعم إذا كان ذلك غير متوقع.`,
      category: 'company',
      icon: 'business-outline',
      iconBg: '#FEF2F2',
      iconColor: '#DC2626',
      data: { type: 'company_owner_removed', companyId: company.id },
    });
  }
  if (ownerId && String(ownerId) !== previousOwner) {
    await createAndSendNotification({
      userId: ownerId,
      audience: 'company',
      title: 'تم ربط حسابك بشركة',
      subtitle: `ربطت إدارة سدرة حسابك بشركة ${company.name} كمالك لها. افتح تطبيق سدرة للشركات لإدارتها.`,
      category: 'company',
      icon: 'business-outline',
      iconBg: '#ECFDF5',
      iconColor: '#059669',
      data: { type: 'company_owner_added', companyId: company.id },
    });
  }
};
