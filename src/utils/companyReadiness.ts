import { pool } from '../config/db';
import { companyActiveSql, isCompanySuspended } from './companySuspension';

/*
 * A company appears to customers only once its public profile is complete: logo, description, contact,
 * address, working hours, official documents (none rejected) and at least one published package.
 * The same rules exist as SQL (to filter lists) and as a checklist (to tell the company what is missing).
 */

const filled = (column: string) => `NULLIF(TRIM(COALESCE(${column}, '')), '') IS NOT NULL`;

// SQL condition that is true when the company behind `alias` is complete
export const companyReadySql = (alias = 'c') => `(
  ${companyActiveSql(alias)}
  AND ${filled(`${alias}.logo_url`)}
  AND (${filled(`${alias}.short_description`)} OR ${filled(`${alias}.description`)})
  AND (${filled(`${alias}.phone`)} OR ${filled(`${alias}.whatsapp`)} OR ${filled(`${alias}.landline_phone`)})
  AND ${alias}.city_id IS NOT NULL AND ${filled(`${alias}.address`)}
  AND ${alias}.working_hours IS NOT NULL AND REPLACE(${alias}.working_hours::text, ' ', '') LIKE '%"isOff":false%'
  AND ${filled(`${alias}.commercial_register_url`)} AND ${filled(`${alias}.tax_id_url`)}
  AND COALESCE(${alias}.documents_review, '') NOT LIKE '%"status":"rejected"%'
  AND EXISTS (SELECT 1 FROM packages rp WHERE rp.company_id = ${alias}.id AND (rp.status = 'active' OR rp.status IS NULL))
)`;

export interface ReadinessItem {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  // Where the company fixes it in its app
  section: 'basic' | 'contact' | 'location' | 'branding' | 'hours' | 'documents' | 'packages';
}

const has = (value: unknown) => typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;

const parseJson = (value: any) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

export const getCompanyReadiness = async (companyId: string): Promise<{ ready: boolean; items: ReadinessItem[] }> => {
  const result = await pool.query(
    `SELECT c.*, (SELECT COUNT(*)::int FROM packages p WHERE p.company_id = c.id AND (p.status = 'active' OR p.status IS NULL)) AS active_packages
     FROM companies c WHERE c.id = $1`,
    [companyId]
  );
  const c = result.rows[0] || {};
  const hours = parseJson(c.working_hours);
  const openDay = hours && typeof hours === 'object' && Object.values(hours).some((day: any) => day && day.isOff === false);
  const review = parseJson(c.documents_review) || {};
  const rejected = Object.values(review).some((item: any) => item?.status === 'rejected');

  const items: ReadinessItem[] = [
    { key: 'logo', label: 'شعار الشركة', hint: 'ارفع شعار شركتك', done: has(c.logo_url), section: 'branding' },
    { key: 'description', label: 'وصف الشركة', hint: 'اكتب وصفاً يعرّف العملاء بشركتك', done: has(c.short_description) || has(c.description), section: 'basic' },
    { key: 'contact', label: 'بيانات الاتصال', hint: 'أضف رقم جوال أو واتساب', done: has(c.phone) || has(c.whatsapp) || has(c.landline_phone), section: 'contact' },
    { key: 'location', label: 'العنوان والمحافظة', hint: 'حدد المحافظة واكتب عنوان المكتب', done: has(c.city_id) && has(c.address), section: 'location' },
    { key: 'hours', label: 'أوقات العمل', hint: 'حدد أيام وساعات العمل لتحديد مواعيد الزيارات', done: Boolean(openDay), section: 'hours' },
    {
      key: 'documents',
      label: 'المستندات الرسمية',
      hint: rejected ? 'رفضت الإدارة أحد المستندات، ارفع نسخة جديدة' : 'ارفع السجل التجاري والبطاقة الضريبية',
      done: has(c.commercial_register_url) && has(c.tax_id_url) && !rejected,
      section: 'documents',
    },
    { key: 'packages', label: 'باقة منشورة', hint: 'أضف باقة واحدة على الأقل وانشرها', done: Number(c.active_packages || 0) > 0, section: 'packages' },
  ];
  // A suspended company stays hidden even with a complete profile
  return { ready: items.every((item) => item.done) && !isCompanySuspended(c), items };
};
