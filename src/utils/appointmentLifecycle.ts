import { pool } from '../config/db';
import { env } from '../config/env';
import { io } from '../server';
import { generate16CharId } from './formatId';
import { createAndSendNotification } from './notificationHelper';

/**
 * Appointment lifecycle
 *
 *   pending   -> the company proposed a time; waiting for the customer to confirm
 *   confirmed -> agreed by both sides
 *   attended  -> the customer came (company pressed "attended" or accepted the order)
 *   missed    -> confirmed, but the customer did not come at any time during that day:
 *                cancelled automatically after the day ends (platform time zone)
 *   expired   -> still pending when its day ended, so it was never agreed
 *   rejected  -> the customer declined it
 *   cancelled -> the company cancelled it
 *
 * Bookings mirror this in bookings.appointment_status ('suggested' plays the role of 'pending').
 */

export const OPEN_APPOINTMENT_STATUSES = ['pending', 'suggested', 'confirmed'];
const DATE_PATTERN = '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';

/** Today's date (YYYY-MM-DD) in the platform time zone. */
export const localToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: env.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const localHour = (): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: env.APP_TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

/** True when the given YYYY-MM-DD day has already ended in the platform time zone. */
export const isPastAppointmentDay = (date: unknown): boolean => {
  const day = String(date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < localToday();
};

const notifyChat = async (chatId: string | null, userId: string, companyName: string, text: string, appointment: any) => {
  if (!chatId) return;
  const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', timeZone: env.APP_TIMEZONE });
  const msg = await pool.query(
    `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, time, status)
     VALUES ($1, $2, $3, $4, 'company', $5, $6, 'received') RETURNING *`,
    [generate16CharId(), chatId, userId, companyName, text, timeStr]
  );
  if (io) {
    io.to(`chat_${chatId}`).emit('receive_message', msg.rows[0]);
    io.to(`chat_${chatId}`).emit('appointment_updated', appointment);
  }
};

const companyOwnerId = async (companyName: string): Promise<string | null> => {
  const res = await pool.query('SELECT user_id FROM companies WHERE name = $1 AND user_id IS NOT NULL LIMIT 1', [companyName]);
  return res.rows[0]?.user_id || null;
};

const customerName = async (userId: string): Promise<string> => {
  const res = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
  return res.rows[0]?.name || 'العميل';
};

// The visit stage showed the customer this date; replace it with what to do next
const updateVisitStageSubtitle = async (bookingId: string, missed: boolean, date: string) => {
  await pool.query(
    `UPDATE trip_stages SET subtitle = $1 WHERE booking_id = $2 AND stage_order = 1 AND status <> 'completed'`,
    [missed
      ? `فاتك موعد الزيارة (${date}) وتم إلغاؤه لعدم الحضور. تواصل مع الشركة لتحديد موعد جديد`
      : `انتهى الموعد المقترح (${date}) دون تأكيد. تواصل مع الشركة لتحديد موعد جديد للزيارة`,
     bookingId]
  );
};

const MISSED_REASON ='تم إلغاء الموعد تلقائياً لعدم حضور العميل خلال يوم الموعد';
const EXPIRED_REASON = 'انتهى يوم الموعد دون أن يؤكده العميل';

/**
 * Closes appointments whose day has ended: confirmed ones become 'missed' (no-show),
 * unconfirmed ones become 'expired'. Safe to run repeatedly.
 */
// The scheduler and the check on read must never run at the same time, or both would notify for one appointment
let running: Promise<{ missed: number; expired: number }> | null = null;

export function expireOverdueAppointments(): Promise<{ missed: number; expired: number }> {
  if (!running) {
    running = runExpiry().finally(() => {
      running = null;
    });
  }
  return running;
}

async function runExpiry(): Promise<{ missed: number; expired: number }> {
  const today = localToday();
  const notified = new Set<string>();
  let missed = 0;
  let expired = 0;

  const appts = await pool.query(
    `UPDATE interview_appointments a
     SET status = CASE WHEN a.status = 'confirmed' THEN 'missed' ELSE 'expired' END,
         status_reason = CASE WHEN a.status = 'confirmed' THEN $2 ELSE $3 END,
         status_changed_at = NOW()
     WHERE a.status = ANY($4::text[])
       AND a.appointment_date ~ '${DATE_PATTERN}'
       AND LEFT(a.appointment_date, 10)::date < $1::date
     RETURNING a.*`,
    [today, MISSED_REASON, EXPIRED_REASON, OPEN_APPOINTMENT_STATUSES]
  );

  for (const appt of appts.rows) {
    const isMissed = appt.status === 'missed';
    isMissed ? missed++ : expired++;
    notified.add(`${appt.user_id}|${appt.company_name}`);

    // Keep the booking with this company in step, while it is still waiting for the visit
    const linked = await pool.query(
      `UPDATE bookings b SET appointment_status = $1
       FROM packages p, companies c
       WHERE b.package_id = p.id AND p.company_id = c.id AND c.name = $2 AND b.user_id = $3
         AND b.status = 'new' AND b.appointment_status = ANY($4::text[])
       RETURNING b.id`,
      [appt.status, appt.company_name, appt.user_id, OPEN_APPOINTMENT_STATUSES]
    );
    for (const row of linked.rows) {
      await updateVisitStageSubtitle(row.id, isMissed, String(appt.appointment_date).slice(0, 10));
    }

    await announceClosedAppointment({
      userId: appt.user_id,
      companyName: appt.company_name,
      chatId: appt.chat_id,
      date: String(appt.appointment_date).slice(0, 10),
      time: appt.appointment_time,
      missed: isMissed,
      appointment: appt,
    });
  }

  // Booking-level appointments (the date suggested when the booking was made) that have no proposal record
  const bookings = await pool.query(
    `UPDATE bookings b
     SET appointment_status = CASE WHEN b.appointment_status = 'confirmed' THEN 'missed' ELSE 'expired' END
     FROM packages p, companies c
     WHERE b.package_id = p.id AND p.company_id = c.id
       AND b.status = 'new'
       AND b.appointment_status = ANY($2::text[])
       AND b.appointment_date IS NOT NULL AND b.appointment_date < $1::date
       AND NOT EXISTS (SELECT 1 FROM trip_stages s WHERE s.booking_id = b.id AND s.stage_order = 1 AND s.status = 'completed')
     RETURNING b.id, b.user_id, b.booking_reference, b.appointment_status, to_char(b.appointment_date, 'YYYY-MM-DD') AS appointment_day,
               b.appointment_time, c.name AS company_name`,
    [today, OPEN_APPOINTMENT_STATUSES]
  );

  for (const b of bookings.rows) {
    const isMissed = b.appointment_status === 'missed';
    isMissed ? missed++ : expired++;
    const date = b.appointment_day;
    await updateVisitStageSubtitle(b.id, isMissed, date);

    const key = `${b.user_id}|${b.company_name}`;
    if (notified.has(key)) continue;
    notified.add(key);
    await announceClosedAppointment({
      userId: b.user_id,
      companyName: b.company_name,
      chatId: null,
      date,
      time: b.appointment_time,
      missed: isMissed,
      bookingRef: b.booking_reference,
      appointment: { status: b.appointment_status },
    });
  }

  return { missed, expired };
}

async function announceClosedAppointment(opts: {
  userId: string; companyName: string; chatId: string | null; date: string; time: string;
  missed: boolean; bookingRef?: string; appointment: any;
}) {
  const { userId, companyName, chatId, date, time, missed, bookingRef } = opts;
  const when = `${date}${time ? ` الساعة ${time}` : ''}`;

  const customerText = missed
    ? `تم إلغاء موعدك مع ${companyName} بتاريخ ${when} تلقائياً لعدم الحضور خلال يوم الموعد. تواصل مع الشركة لتحديد موعد جديد.`
    : `انتهى موعدك المقترح مع ${companyName} بتاريخ ${when} دون تأكيد. تواصل مع الشركة لتحديد موعد جديد.`;

  try {
    await notifyChat(chatId, userId, companyName, `⏰ ${customerText}`, opts.appointment);
    await createAndSendNotification({
      userId,
      title: missed ? 'تم إلغاء الموعد لعدم الحضور' : 'انتهى الموعد دون تأكيد',
      subtitle: customerText,
      category: 'appointment',
      icon: 'calendar-outline',
      iconBg: '#FEF2F2',
      iconColor: '#DC2626',
      data: { type: missed ? 'appointment_missed' : 'appointment_expired', appointmentDate: date, bookingRef },
    });

    if (missed) {
      const ownerId = await companyOwnerId(companyName);
      if (ownerId) {
        await createAndSendNotification({
          userId: ownerId,
          audience: 'company',
          title: 'عميل لم يحضر موعده',
          subtitle: `لم يحضر ${await customerName(userId)} موعد ${when}، وتم إلغاء الموعد تلقائياً. يمكنك تحديد موعد جديد له.`,
          category: 'appointment',
          icon: 'calendar-outline',
          iconBg: '#FEF2F2',
          iconColor: '#DC2626',
          data: { type: 'appointment_missed', appointmentDate: date, bookingRef },
        });
      }
    }
  } catch (err) {
    console.error('Failed to announce closed appointment:', err);
  }
}

/** Sends one reminder on the morning of each confirmed appointment day. */
export async function sendAppointmentDayReminders(): Promise<number> {
  if (localHour() < 8) return 0;
  const today = localToday();
  const notified = new Set<string>();

  const appts = await pool.query(
    `UPDATE interview_appointments
     SET reminder_sent_at = NOW()
     WHERE status = 'confirmed' AND reminder_sent_at IS NULL
       AND appointment_date ~ '${DATE_PATTERN}' AND LEFT(appointment_date, 10)::date = $1::date
     RETURNING *`,
    [today]
  );
  const bookings = await pool.query(
    `UPDATE bookings b SET appointment_reminder_sent_at = NOW()
     FROM packages p, companies c
     WHERE b.package_id = p.id AND p.company_id = c.id AND b.status = 'new'
       AND b.appointment_status = 'confirmed' AND b.appointment_reminder_sent_at IS NULL
       AND b.appointment_date = $1::date
     RETURNING b.user_id, b.appointment_time, b.booking_reference, c.name AS company_name, c.address AS location`,
    [today]
  );

  const rows = [
    ...appts.rows.map((a: any) => ({ userId: a.user_id, companyName: a.company_name, time: a.appointment_time, location: a.location, chatId: a.chat_id })),
    ...bookings.rows.map((b: any) => ({ userId: b.user_id, companyName: b.company_name, time: b.appointment_time, location: b.location, chatId: null })),
  ];

  for (const r of rows) {
    const key = `${r.userId}|${r.companyName}`;
    if (notified.has(key)) continue;
    notified.add(key);
    try {
      await createAndSendNotification({
        userId: r.userId,
        title: 'تذكير: موعدك اليوم',
        subtitle: `موعدك مع ${r.companyName} اليوم${r.time ? ` الساعة ${r.time}` : ''}${r.location ? ` في ${r.location}` : ''}. إذا لم تحضر خلال اليوم سيتم إلغاء الموعد تلقائياً.`,
        category: 'appointment',
        icon: 'alarm-outline',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        data: { type: 'appointment_reminder', appointmentDate: today },
      });
    } catch (err) {
      console.error('Failed to send appointment reminder:', err);
    }
  }
  return notified.size;
}

/**
 * Records that the customer came to the company. Used when the company accepts the order
 * (the visit) or presses "attended". A wrongly missed appointment can be corrected this way.
 */
export async function markAppointmentAttended(userId: string, companyName: string, bookingId?: string): Promise<void> {
  await pool.query(
    `UPDATE interview_appointments
     SET status = 'attended', attended_at = NOW(), status_changed_at = NOW(), status_reason = NULL
     WHERE id = (
       SELECT id FROM interview_appointments
       WHERE user_id = $1 AND company_name = $2 AND status IN ('pending', 'suggested', 'confirmed', 'missed', 'expired')
       ORDER BY created_at DESC LIMIT 1
     )`,
    [userId, companyName]
  );
  if (bookingId) {
    await pool.query(
      `UPDATE bookings SET appointment_status = 'attended' WHERE id = $1 AND appointment_date IS NOT NULL`,
      [bookingId]
    );
  }
}

let lastRun = 0;
/** Runs the expiry check at most once a minute; called before appointments are read. */
export async function expireOverdueAppointmentsThrottled(): Promise<void> {
  if (Date.now() - lastRun < 60_000) return;
  lastRun = Date.now();
  await expireOverdueAppointments().catch((err) => console.error('Appointment expiry failed:', err));
}

/** Checks every 10 minutes, so a missed appointment is closed shortly after midnight. */
export function startAppointmentScheduler(): void {
  const tick = async () => {
    try {
      lastRun = Date.now();
      const { missed, expired } = await expireOverdueAppointments();
      if (missed || expired) console.log(`📅 Appointments closed: ${missed} missed (no-show), ${expired} expired unconfirmed`);
      await sendAppointmentDayReminders();
    } catch (err) {
      console.error('Appointment scheduler error:', err);
    }
  };
  // First run after the schema migrations have had time to finish
  setTimeout(tick, 60_000);
  setInterval(tick, 10 * 60_000);
}
