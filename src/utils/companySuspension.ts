/*
 * A company suspended by the platform disappears from the customer app, takes no new bookings and cannot
 * publish or edit packages. Its team can still sign in, see why, serve the bookings it already has and
 * talk to Sdra support. A suspension with `suspended_until` ends by itself once that moment passes.
 */

// SQL condition that is true while the company behind `alias` is NOT suspended
export const companyActiveSql = (alias = 'c') =>
  `NOT (COALESCE(${alias}.status, 'active') = 'suspended' AND (${alias}.suspended_until IS NULL OR ${alias}.suspended_until > NOW()))`;

export const isCompanySuspended = (company: any): boolean => {
  if (!company || company.status !== 'suspended') return false;
  if (!company.suspended_until) return true;
  return new Date(company.suspended_until).getTime() > Date.now();
};

export const suspensionInfo = (company: any) => ({
  is_suspended: isCompanySuspended(company),
  suspension_reason: isCompanySuspended(company) ? company.suspension_reason || null : null,
  suspended_at: isCompanySuspended(company) ? company.suspended_at || null : null,
  suspended_until: isCompanySuspended(company) ? company.suspended_until || null : null,
});

export const SUSPENDED_ERROR = 'حساب الشركة موقوف من إدارة سدرة، لا يمكن تنفيذ هذا الإجراء. تواصل مع الدعم للمزيد';
