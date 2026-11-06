import { z } from 'zod';

const shortText = (max = 255) => z.string().trim().max(max);
const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((value) => value === '' || /^https?:\/\/\S+$/i.test(value), 'يجب أن يبدأ الرابط بـ http:// أو https://');
const phone = z
  .string()
  .trim()
  .max(50)
  .refine((value) => value === '' || /^[+\d][\d\s()-]{4,}$/.test(value), 'رقم الهاتف غير صحيح');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'صيغة الوقت غير صحيحة');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة');
const optionalDate = z.union([isoDate, z.literal('')]);
const fileLink = z.string().trim().max(2000);

const workingDay = z.object({ open: time, close: time, isOff: z.boolean() }).strict();

// verified, field_verified, name, rating and the owner are absent on purpose: only the platform changes those
export const companyProfileSchema = z
  .object({
    short_description: shortText(300),
    description: shortText(5000),
    phone,
    whatsapp: phone,
    landline_phone: phone,
    contact_email: z.union([z.string().trim().email('البريد الإلكتروني غير صحيح').max(255), z.literal('')]),
    website_url: httpUrl,
    social_links: z
      .object({ facebook: httpUrl, tiktok: httpUrl, instagram: httpUrl, linkedin: httpUrl, youtube: httpUrl })
      .partial()
      .strict(),
    city_id: z.string().trim().min(1).max(16),
    address: shortText(1000),
    google_maps_url: httpUrl,
    logo_url: fileLink,
    banner_url: fileLink,
    working_hours: z
      .object({
        sunday: workingDay,
        monday: workingDay,
        tuesday: workingDay,
        wednesday: workingDay,
        thursday: workingDay,
        friday: workingDay,
        saturday: workingDay,
      })
      .strict(),
    holidays_notes: shortText(1000),
    max_daily_capacity: z.number().int().min(1, 'عدد الزيارات اليومية 1 على الأقل').max(200, 'عدد الزيارات اليومية كبير جداً'),
    slot_duration_minutes: z.number().int().min(10, 'مدة الزيارة 10 دقائق على الأقل').max(240, 'مدة الزيارة 4 ساعات على الأكثر'),
    commercial_register_url: fileLink,
    tax_id_url: fileLink,
    manager_id_url: fileLink,
    manager_id_back_url: fileLink,
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'لا توجد بيانات للحفظ');

const money = z.union([
  z.literal(''),
  z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'السعر غير صحيح'),
]);
const guestLimit = z.string().regex(/^(unlimited|\d{1,4})$/, 'الحد الأقصى غير صحيح');
const noChildren = z.enum(['1', '']);

export const companyPackageSchema = z
  .object({
    title: shortText(255).min(2, 'أدخل عنوان الباقة'),
    duration: shortText(100).min(1, 'أدخل مدة الباقة'),
    description: shortText(5000).default(''),
    // Required because the customer app filters packages by nights and travel month
    nights_count: z.string({ required_error: 'أدخل عدد الليالي' }).regex(/^\d{1,3}$/, 'أدخل عدد الليالي'),
    departure_date: isoDate,
    return_date: optionalDate.default(''),
    departure_airport: shortText(100).default(''),
    hotel_makkah: shortText(255).min(1, 'أدخل فندق مكة'),
    hotel_madinah: shortText(255).min(1, 'أدخل فندق المدينة'),
    room_prices: z
      .object({
        quad: money,
        quad_child: money,
        triple: money,
        triple_child: money,
        double: money,
        double_child: money,
        single: money,
        single_child: money,
        // '1' marks a room that does not take children
        quad_no_children: noChildren,
        triple_no_children: noChildren,
        double_no_children: noChildren,
        single_no_children: noChildren,
      })
      .partial()
      .strict(),
    max_adults: guestLimit.default('unlimited'),
    max_children: guestLimit.default('unlimited'),
    cancellation_policy: shortText(2000).default(''),
    image_url: fileLink.default(''),
    features: z.array(shortText(200)).max(50).default([]),
    itinerary: z
      .array(z.object({ title: shortText(200), desc: shortText(2000).default('') }).strict())
      .max(60)
      .default([]),
    gallery: z.array(fileLink).max(10, 'الألبوم 10 صور على الأكثر').default([]),
    exclusions: z.array(shortText(200)).max(50).default([]),
    seats_total: z.union([z.literal(''), z.string().regex(/^\d{1,4}$/, 'عدد المقاعد غير صحيح')]).default(''),
    visa_info: shortText(2000).default(''),
    transport_info: shortText(2000).default(''),
    original_price: money.default(''),
    includes_flight: z.boolean().default(false),
    season: z.enum(['regular', 'ramadan', 'shaban', 'rajab', 'mid_year', 'summer', 'winter'], { errorMap: () => ({ message: 'اختر موسم الرحلة' }) }),
  })
  .strict()
  .refine(
    (body) => ['quad', 'triple', 'double', 'single'].some((key) => Number((body.room_prices as any)[key]) > 0),
    { message: 'أدخل سعر البالغ لنوع غرفة واحد على الأقل', path: ['room_prices'] }
  )
  .refine((body) => !body.departure_date || !body.return_date || body.return_date >= body.departure_date, {
    message: 'تاريخ العودة يجب أن يكون بعد تاريخ الذهاب',
    path: ['return_date'],
  });

// 'hidden' is reserved for the platform, so a company cannot republish what the admin took down
export const packageStatusSchema = z.object({ status: z.enum(['active', 'paused']) }).strict();

export const rejectOrderSchema = z
  .object({ reason: shortText(200).min(2, 'اكتب سبب الرفض للعميل') })
  .strict();

export const cancelOrderSchema = z
  .object({ reason: shortText(500).min(2, 'اكتب سبب الإلغاء للعميل') })
  .strict();


export const updateStageSchema = z
  .object({
    document_url: fileLink.optional(),
    document_number: shortText(100).optional(),
    traveler_name: shortText(255).optional(),
    instructions: shortText(3000).optional(),
    complete: z.boolean().optional(),
    // One document per traveler; docType tells the customer app where to list it
    travelers: z
      .array(
        z
          .object({
            name: shortText(255).min(1, 'اكتب اسم المسافر'),
            docNumber: shortText(100).optional(),
            docUrl: fileLink.optional(),
            docType: z.enum(['visa', 'ticket', 'hotel', 'other']).optional(),
          })
          .strict()
      )
      .max(60)
      .optional(),
  })
  .strict();

export const startChatSchema = z.object({ userId: z.string().trim().min(1).max(16) }).strict();

export const chatMessageSchema = z
  .object({ message: shortText(4000).optional(), imageUri: fileLink.optional() })
  .strict()
  .refine((body) => Boolean(body.message || body.imageUri), 'محتوى الرسالة مطلوب');

export const appointmentSchema = z
  .object({
    userId: z.string().trim().min(1).max(16),
    appointmentDate: isoDate,
    appointmentTime: shortText(50).min(1, 'اختر وقت الموعد'),
    location: shortText(255).optional(),
    title: shortText(255).optional(),
    notes: shortText(1000).optional(),
    chatId: z.string().trim().max(16).optional(),
  })
  .strict();

export const rescheduleAppointmentSchema = z
  .object({
    appointmentDate: isoDate,
    appointmentTime: shortText(50).min(1, 'اختر وقت الموعد'),
    location: shortText(255).optional(),
    notes: shortText(1000).optional(),
  })
  .strict();

export const cancelAppointmentSchema = z
  .object({ reason: shortText(500).min(2, 'اكتب سبب الإلغاء للعميل') })
  .strict();

export const clientNoteSchema = z.object({ note: shortText(2000) }).strict();

// ───── Team ─────

const roleColor = z.union([z.literal(''), z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'اللون غير صحيح')]);
const permissionList = z.array(z.string().trim().max(60)).max(100);

export const addMemberSchema = z
  .object({
    email: z.string().trim().email('البريد الإلكتروني غير صحيح').max(255),
    roleId: z.string().trim().min(1, 'اختر الدور').max(16),
    jobTitle: shortText(150).optional(),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    roleId: z.string().trim().min(1).max(16).optional(),
    jobTitle: shortText(150).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();

export const createRoleSchema = z
  .object({
    name: shortText(100).min(2, 'اكتب اسم الدور'),
    description: shortText(300).optional(),
    color: roleColor.optional(),
    permissions: permissionList,
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: shortText(100).min(2, 'اكتب اسم الدور').optional(),
    description: shortText(300).optional(),
    color: roleColor.optional(),
    permissions: permissionList.optional(),
  })
  .strict();

export const companyTicketSchema = z
  .object({
    title: shortText(200).min(3, 'اكتب عنوان التذكرة'),
    message: shortText(3000).min(3, 'اكتب تفاصيل طلبك'),
    category: z.enum(['general', 'payments', 'packages', 'bookings', 'account', 'technical']).default('general'),
    bookingReference: shortText(50).optional(),
    attachmentUrl: fileLink.optional(),
  })
  .strict();

export const ticketMessageSchema = z
  .object({ message: shortText(3000).optional(), imageUri: fileLink.optional() })
  .strict()
  .refine((body) => Boolean(body.message || body.imageUri), 'اكتب رسالة أو أرفق صورة');

export const reviewReplySchema = z.object({ reply: shortText(1000) }).strict();
