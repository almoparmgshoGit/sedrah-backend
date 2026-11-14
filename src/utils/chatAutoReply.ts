import { pool } from '../config/db';
import { toArabicTime } from './appointmentEngine';

/*
 * Automatic answers to the suggested questions a customer can tap in a chat with a company.
 * The questions are fixed by the platform (companies cannot add their own); each answer is built only
 * from what the company entered in its profile, so it never states details that are not real.
 * When the needed detail is missing, the answer says the team will reply and the company is notified as usual.
 */

export const AUTO_REPLY_SENDER_NAME = 'رد آلي';

export const QUICK_QUESTIONS: Record<string, string> = {
  payment: 'ما هي طرق الدفع المتاحة؟',
  hours: 'ما هي مواعيد العمل الرسمية؟',
  location: 'أرغب في معرفة موقع المكتب بالتفصيل.',
  contact: 'ما هي أرقام التواصل مع الشركة؟',
};

const HANDOFF = 'لم تُضف الشركة هذه المعلومة بعد، وسيرد عليك أحد موظفي الشركة في أقرب وقت.';

const DAYS: Array<{ key: string; legacy: string; label: string }> = [
  { key: 'saturday', legacy: 'Saturday', label: 'السبت' },
  { key: 'sunday', legacy: 'Sunday', label: 'الأحد' },
  { key: 'monday', legacy: 'Monday', label: 'الاثنين' },
  { key: 'tuesday', legacy: 'Tuesday', label: 'الثلاثاء' },
  { key: 'wednesday', legacy: 'Wednesday', label: 'الأربعاء' },
  { key: 'thursday', legacy: 'Thursday', label: 'الخميس' },
  { key: 'friday', legacy: 'Friday', label: 'الجمعة' },
];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const parseJson = (value: any) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const clean = (value: any) => String(value ?? '').trim();

/** The question id a message stands for: the id the app sent, or the exact text of a suggested question (older app builds). */
export function matchQuickQuestion(quickReplyId: any, message: any): string | null {
  const id = clean(quickReplyId);
  if (id && QUICK_QUESTIONS[id]) return id;
  const text = clean(message);
  return Object.keys(QUICK_QUESTIONS).find((key) => QUICK_QUESTIONS[key] === text) || null;
}

// Same rules as the visit-slot engine: per-day hours first, then the older days/start/end settings
function describeHours(company: any): string | null {
  const hours = parseJson(company.working_hours);
  const lines: string[] = [];
  const offDays: string[] = [];

  const perDay = hours && DAYS.some((d) => hours[d.key]);
  if (perDay) {
    for (const d of DAYS) {
      const day = hours[d.key];
      if (!day) continue;
      if (day.isOff) offDays.push(d.label);
      else if (TIME.test(day.open) && TIME.test(day.close)) lines.push(`• ${d.label}: من ${toArabicTime(day.open)} إلى ${toArabicTime(day.close)}`);
    }
  } else {
    const legacyDays = parseJson(company.working_days);
    const start = clean(company.working_hours_start);
    const end = clean(company.working_hours_end);
    if (!Array.isArray(legacyDays) || !TIME.test(start) || !TIME.test(end)) return null;
    const open = DAYS.filter((d) => legacyDays.includes(d.legacy));
    if (open.length === 0) return null;
    lines.push(`• ${open.map((d) => d.label).join('، ')}: من ${toArabicTime(start)} إلى ${toArabicTime(end)}`);
    offDays.push(...DAYS.filter((d) => !legacyDays.includes(d.legacy)).map((d) => d.label));
  }

  if (lines.length === 0) return null;
  let text = `مواعيد العمل في مكتبنا:\n${lines.join('\n')}`;
  if (offDays.length > 0) text += `\nالإجازة: ${offDays.join('، ')}`;
  const holidays = clean(company.holidays_notes);
  if (holidays) text += `\nملاحظات: ${holidays}`;
  return text;
}

function describeLocation(company: any): string | null {
  const address = clean(company.address);
  const map = clean(company.google_maps_url);
  if (!address && !map) return null;
  const parts = [address && `مقر مكتبنا: ${address}`, map && `الموقع على الخريطة: ${map}`].filter(Boolean);
  return parts.join('\n');
}

function describeContact(company: any): string | null {
  const parts = [
    clean(company.phone) && `الهاتف: ${clean(company.phone)}`,
    clean(company.whatsapp) && `واتساب: ${clean(company.whatsapp)}`,
    clean(company.landline_phone) && `الهاتف الأرضي: ${clean(company.landline_phone)}`,
  ].filter(Boolean);
  return parts.length > 0 ? `للتواصل معنا:\n${parts.join('\n')}` : null;
}

// Payment is a platform rule: the customer pays at the office, then uploads the receipt for review
function describePayment(company: any): string {
  const address = clean(company.address);
  return [
    'يتم سداد قيمة الحجز في مقر الشركة أثناء زيارتك للمكتب' + (address ? ` (${address}).` : '.'),
    'بعد الدفع ارفع صورة إيصال السداد من صفحة الحجز في التطبيق، وسيتم مراجعته وتأكيد حجزك.',
  ].join('\n');
}

/** The automatic answer, and whether it fully answered the question (false means the team still has to reply). */
export async function buildAutoReply(questionId: string, companyId: string): Promise<{ text: string; answered: boolean } | null> {
  const res = await pool.query(
    `SELECT address, google_maps_url, phone, whatsapp, landline_phone, working_hours, working_days,
            working_hours_start, working_hours_end, holidays_notes
     FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = res.rows[0];
  if (!company) return null;

  let text: string | null = null;
  if (questionId === 'payment') text = describePayment(company);
  else if (questionId === 'hours') text = describeHours(company);
  else if (questionId === 'location') text = describeLocation(company);
  else if (questionId === 'contact') text = describeContact(company);
  else return null;

  return text ? { text, answered: true } : { text: HANDOFF, answered: false };
}
