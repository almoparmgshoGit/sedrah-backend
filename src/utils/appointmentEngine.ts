import { pool } from '../config/db';

/*
 * Picks the first free office-visit slot for a new booking. It follows the hours the company sets in its app
 * (working_hours, one entry per weekday), its daily visit limit and visit length, and skips times already taken
 * by other bookings or by appointments the company scheduled itself.
 */

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const LEGACY_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SEARCH_DAYS = 21;

type DaySchedule = { open: string; close: string; isOff: boolean };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const parseJson = (value: any) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

// Local calendar date, so a slot near midnight never lands on the wrong day
const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// "14:30" becomes "2:30 م", the format appointments are stored and shown in across the platform
export const toArabicTime = (hhmm: string): string => {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'ص' : 'م'}`;
};

// Accepts both stored formats ("14:30" and "2:30 م") so taken slots are compared reliably
export const toMinutes = (value: string): number | null => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})\s*(ص|م|AM|PM|am|pm)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const suffix = match[3];
  if (suffix === 'م' || suffix?.toLowerCase() === 'pm') hours = hours % 12 + 12;
  if (suffix === 'ص' || suffix?.toLowerCase() === 'am') hours = hours % 12;
  return hours * 60 + minutes;
};

const scheduleFor = (company: any, date: Date): DaySchedule | null => {
  const hours = parseJson(company.working_hours);
  const day = hours?.[DAY_KEYS[date.getDay()]];
  if (day && TIME.test(day.open) && TIME.test(day.close)) return day.isOff ? null : day;

  // Companies that never opened the hours screen keep the older settings
  let workingDays: string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
  const legacy = parseJson(company.working_days);
  if (Array.isArray(legacy)) workingDays = legacy;
  if (!workingDays.includes(LEGACY_DAY_NAMES[date.getDay()])) return null;
  return {
    open: TIME.test(company.working_hours_start) ? company.working_hours_start : '09:00',
    close: TIME.test(company.working_hours_end) ? company.working_hours_end : '17:00',
    isOff: false,
  };
};

export function generateTimeSlots(startTimeStr: string, endTimeStr: string, durationMins: number): string[] {
  const slots: string[] = [];
  const start = toMinutes(startTimeStr) ?? 9 * 60;
  const end = toMinutes(endTimeStr) ?? 17 * 60;
  for (let current = start; current + durationMins <= end; current += durationMins) {
    slots.push(`${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}`);
  }
  return slots;
}

export interface VisitDay {
  date: string;
  times: string[];
}

/**
 * The free office-visit times of a company for the coming days. A visit counts once per customer and time,
 * whether it is a booking visit, an appointment the company set, or both for the same booking.
 */
export async function availableVisitSlots(companyId: number | string, days = SEARCH_DAYS): Promise<VisitDay[]> {
  const compRes = await pool.query(
    `SELECT name, working_hours, working_days, working_hours_start, working_hours_end, max_daily_capacity, slot_duration_minutes
     FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = compRes.rows[0];
  if (!company) return [];

  const maxPerDay = Number(company.max_daily_capacity) > 0 ? Number(company.max_daily_capacity) : 10;
  const duration = Number(company.slot_duration_minutes) >= 10 ? Number(company.slot_duration_minutes) : 30;

  const result: VisitDay[] = [];
  const today = new Date();
  for (let offset = 1; offset <= days; offset++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const schedule = scheduleFor(company, date);
    if (!schedule) continue;
    const dateISO = isoDate(date);

    const taken = await pool.query(
      `SELECT b.user_id, b.appointment_time AS time FROM bookings b JOIN packages p ON b.package_id = p.id
       WHERE p.company_id = $1 AND b.appointment_date::text LIKE $2 || '%' AND b.status <> 'cancelled'
         AND COALESCE(b.appointment_status, '') NOT IN ('cancelled', 'rejected', 'expired', 'missed', 'none')
       UNION
       SELECT a.user_id, a.appointment_time AS time FROM interview_appointments a
       WHERE a.company_name = $3 AND a.appointment_date = $2 AND a.status NOT IN ('cancelled', 'rejected', 'expired', 'missed')`,
      [companyId, dateISO, company.name]
    );
    if (taken.rows.length >= maxPerDay) continue;

    const takenMinutes = new Set<number | null>(taken.rows.map((row: any) => toMinutes(row.time)));
    const times = generateTimeSlots(schedule.open, schedule.close, duration)
      .filter((slot) => !takenMinutes.has(toMinutes(slot)))
      .slice(0, maxPerDay - taken.rows.length)
      .map(toArabicTime);
    if (times.length > 0) result.push({ date: dateISO, times });
  }
  return result;
}

// Whether the given day and time is still free for this company
export async function isVisitSlotAvailable(companyId: number | string, date: string, time: string): Promise<boolean> {
  const slots = await availableVisitSlots(companyId);
  const wanted = toMinutes(time);
  return slots.some((day) => day.date === date && day.times.some((slot) => toMinutes(slot) === wanted));
}

export async function suggestAppointmentForBooking(companyId: number | string): Promise<{ date: string; time: string } | null> {
  try {
    const slots = await availableVisitSlots(companyId);
    return slots[0] ? { date: slots[0].date, time: slots[0].times[0] } : null;
  } catch (error) {
    console.error('Error suggesting appointment:', error);
    return null;
  }
}
