/*
 * What a company asks for when a customer books, and which booking methods it accepts.
 *
 * Booking through the Sedrah app ("sidra") fills the company's form. Booking by WhatsApp, phone or an
 * office visit happens outside the app, but the customer still registers it here with a name, phone and a
 * visit time, so the platform and the company both know a booking is coming.
 */

export type FieldMode = 'required' | 'optional' | 'hidden';
export type BookingMethod = 'sidra' | 'whatsapp' | 'phone' | 'office';

export const BOOKING_METHODS: BookingMethod[] = ['sidra', 'whatsapp', 'phone', 'office'];
export const OFF_APP_METHODS: BookingMethod[] = ['whatsapp', 'phone', 'office'];

export const METHOD_LABELS: Record<BookingMethod, string> = {
  sidra: 'تطبيق سدرة',
  whatsapp: 'واتساب',
  phone: 'اتصال هاتفي',
  office: 'زيارة المكتب',
};

// Name and phone are always required, so they are not configurable
export const FORM_FIELDS: Array<{ key: string; label: string; default: FieldMode; maxLength: number }> = [
  { key: 'whatsapp', label: 'رقم الواتساب', default: 'optional', maxLength: 50 },
  { key: 'email', label: 'البريد الإلكتروني', default: 'hidden', maxLength: 255 },
  { key: 'governorate', label: 'المحافظة', default: 'required', maxLength: 255 },
  { key: 'district', label: 'المنطقة / العنوان', default: 'optional', maxLength: 255 },
  { key: 'national_id', label: 'الرقم القومي', default: 'hidden', maxLength: 30 },
  { key: 'travelers', label: 'أسماء المسافرين', default: 'hidden', maxLength: 255 },
  { key: 'notes', label: 'ملاحظات', default: 'optional', maxLength: 2000 },
];

export interface CustomQuestion {
  id: string;
  label: string;
  type: 'text' | 'number' | 'yesno';
  required: boolean;
}

export interface BookingFormConfig {
  fields: Record<string, FieldMode>;
  custom: CustomQuestion[];
  methods: Record<BookingMethod, boolean>;
}

const MODES: FieldMode[] = ['required', 'optional', 'hidden'];
export const MAX_CUSTOM_QUESTIONS = 8;

export const parseBookingForm = (raw: unknown): BookingFormConfig => {
  let stored: any = {};
  try {
    stored = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
  } catch {
    stored = {};
  }
  const fields: Record<string, FieldMode> = {};
  for (const field of FORM_FIELDS) {
    const mode = stored.fields?.[field.key];
    fields[field.key] = MODES.includes(mode) ? mode : field.default;
  }
  const custom: CustomQuestion[] = Array.isArray(stored.custom)
    ? stored.custom
        .filter((item: any) => item && typeof item.label === 'string' && item.label.trim())
        .slice(0, MAX_CUSTOM_QUESTIONS)
        .map((item: any, index: number) => ({
          id: String(item.id || `q${index + 1}`).slice(0, 20),
          label: String(item.label).trim().slice(0, 150),
          type: ['text', 'number', 'yesno'].includes(item.type) ? item.type : 'text',
          required: Boolean(item.required),
        }))
    : [];
  // Booking through the app is always available; the others are the company's choice
  const methods: Record<BookingMethod, boolean> = { sidra: true, whatsapp: true, phone: true, office: true };
  for (const method of OFF_APP_METHODS) {
    if (stored.methods && typeof stored.methods[method] === 'boolean') methods[method] = stored.methods[method];
  }
  return { fields, custom, methods };
};

export class BookingFormError extends Error {}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export interface BookingFormValues {
  customer_name: string;
  customer_phone: string;
  whatsapp: string | null;
  email: string | null;
  governorate: string | null;
  district: string | null;
  national_id: string | null;
  notes: string;
  travelers: Array<{ full_name: string; traveler_type: 'adult' | 'child' }>;
  custom_answers: Array<{ id: string; label: string; answer: string }>;
}

/**
 * Checks a booking against the company's form. Off-app methods need only the name and phone; the rest is
 * collected by the company when the customer contacts or visits it.
 */
export const validateBookingSubmission = (
  form: BookingFormConfig,
  body: any,
  method: BookingMethod,
  counts: { adults: number; children: number }
): BookingFormValues => {
  const name = text(body.customerName, 255);
  const phone = text(body.customerPhone, 50);
  if (name.length < 3) throw new BookingFormError('اكتب الاسم بالكامل');
  if (!/^\+?[0-9\s-]{7,20}$/.test(phone)) throw new BookingFormError('رقم الهاتف غير صالح');

  const offApp = method !== 'sidra';
  const mode = (key: string): FieldMode => (offApp ? 'hidden' : form.fields[key] || 'hidden');
  const read = (key: string, value: unknown, max: number, label: string): string | null => {
    const fieldMode = mode(key);
    if (fieldMode === 'hidden') return null;
    const clean = text(value, max);
    if (!clean && fieldMode === 'required') throw new BookingFormError(`${label} مطلوب`);
    return clean || null;
  };

  const whatsapp = read('whatsapp', body.customerWhatsapp, 50, 'رقم الواتساب');
  if (whatsapp && !/^\+?[0-9\s-]{7,20}$/.test(whatsapp)) throw new BookingFormError('رقم الواتساب غير صالح');
  const email = read('email', body.customerEmail, 255, 'البريد الإلكتروني');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new BookingFormError('البريد الإلكتروني غير صحيح');
  const nationalId = read('national_id', body.nationalId, 30, 'الرقم القومي');
  if (nationalId && !/^[0-9A-Za-z-]{5,30}$/.test(nationalId)) throw new BookingFormError('الرقم القومي غير صحيح');

  let travelers: BookingFormValues['travelers'] = [];
  if (mode('travelers') !== 'hidden') {
    const list = Array.isArray(body.travelers) ? body.travelers : [];
    travelers = list
      .map((row: any) => ({ full_name: text(row?.full_name, 255), traveler_type: row?.traveler_type === 'child' ? 'child' : 'adult' }))
      .filter((row: any) => row.full_name.length >= 3);
    const adults = travelers.filter((row) => row.traveler_type === 'adult').length;
    const children = travelers.filter((row) => row.traveler_type === 'child').length;
    if (adults > counts.adults || children > counts.children) throw new BookingFormError('عدد أسماء المسافرين أكبر من عدد المسافرين في الحجز');
    if (mode('travelers') === 'required' && travelers.length < counts.adults + counts.children) {
      throw new BookingFormError('اكتب أسماء كل المسافرين كما في جوازات السفر');
    }
  }

  const answers: BookingFormValues['custom_answers'] = [];
  if (!offApp) {
    const given = body.customAnswers && typeof body.customAnswers === 'object' ? body.customAnswers : {};
    for (const question of form.custom) {
      const answer = text(given[question.id], 500);
      if (!answer && question.required) throw new BookingFormError(`أجب عن: ${question.label}`);
      if (answer && question.type === 'number' && !/^-?\d+(\.\d+)?$/.test(answer)) throw new BookingFormError(`${question.label}: أدخل رقماً`);
      if (answer && question.type === 'yesno' && !['نعم', 'لا'].includes(answer)) throw new BookingFormError(`${question.label}: اختر نعم أو لا`);
      if (answer) answers.push({ id: question.id, label: question.label, answer });
    }
  }

  return {
    customer_name: name,
    customer_phone: phone,
    whatsapp,
    email,
    governorate: read('governorate', body.governorate, 255, 'المحافظة'),
    district: read('district', body.district, 255, 'المنطقة'),
    national_id: nationalId,
    // A short note is always welcome off the app, since the customer has nowhere else to add one
    notes: offApp || mode('notes') !== 'hidden' ? text(body.notes, 2000) : '',
    travelers,
    custom_answers: answers,
  };
};
