import { pool } from '../config/db';

export interface CompanyScheduleSettings {
  working_days: string[];
  working_hours_start: string;
  working_hours_end: string;
  max_daily_capacity: number;
  slot_duration_minutes: number;
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function suggestAppointmentForBooking(companyId: number): Promise<{ date: string; time: string } | null> {
  try {
    const compRes = await pool.query(
      `SELECT working_days, working_hours_start, working_hours_end, max_daily_capacity, slot_duration_minutes
       FROM companies WHERE id = $1`,
      [companyId]
    );

    if (compRes.rows.length === 0) return null;

    const comp = compRes.rows[0];
    let workingDays: string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    try {
      if (comp.working_days) {
        workingDays = typeof comp.working_days === 'string' ? JSON.parse(comp.working_days) : comp.working_days;
      }
    } catch (e) {}

    const maxCap = comp.max_daily_capacity || 10;
    const durationMins = comp.slot_duration_minutes || 30;
    const startTimeStr = comp.working_hours_start || '09:00';
    const endTimeStr = comp.working_hours_end || '17:00';

    // Search for available slot starting from tomorrow up to 14 days
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const candidateDate = new Date(today);
      candidateDate.setDate(today.getDate() + i);

      const dayName = dayNames[candidateDate.getDay()];
      if (!workingDays.includes(dayName)) continue;

      const dateISO = candidateDate.toISOString().split('T')[0];

      // Check current bookings count for that day
      const countRes = await pool.query(
        `SELECT COUNT(*) FROM bookings b
         JOIN packages p ON b.package_id = p.id
         WHERE p.company_id = $1 AND b.appointment_date = $2 AND (b.status != 'cancelled')`,
        [companyId, dateISO]
      );

      const count = parseInt(countRes.rows[0].count, 10);
      if (count >= maxCap) continue; // Day is full

      // Fetch taken times on that day
      const takenRes = await pool.query(
        `SELECT b.appointment_time FROM bookings b
         JOIN packages p ON b.package_id = p.id
         WHERE p.company_id = $1 AND b.appointment_date = $2 AND b.appointment_time IS NOT NULL AND (b.status != 'cancelled')`,
        [companyId, dateISO]
      );

      const takenTimes = takenRes.rows.map(r => r.appointment_time);

      // Generate time slots
      const slots = generateTimeSlots(startTimeStr, endTimeStr, durationMins);
      const availableSlot = slots.find(slot => !takenTimes.includes(slot));

      if (availableSlot) {
        return { date: dateISO, time: availableSlot };
      }
    }

    return null;
  } catch (error) {
    console.error('Error suggesting appointment:', error);
    return null;
  }
}

export function generateTimeSlots(startTimeStr: string, endTimeStr: string, durationMins: number): string[] {
  const slots: string[] = [];
  const [startH, startM] = startTimeStr.split(':').map(Number);
  const [endH, endM] = endTimeStr.split(':').map(Number);

  let current = startH * 60 + startM;
  const end = endH * 60 + endM;

  while (current + durationMins <= end) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    const timeFormatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    slots.push(timeFormatted);
    current += durationMins;
  }

  return slots;
}
