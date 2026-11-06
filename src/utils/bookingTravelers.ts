import { Request } from 'express';
import { z } from 'zod';
import { pool } from '../config/db';
import { generate16CharId } from './formatId';
import { normalizeUploadUrl, resolveUserUpload } from './uploadAccess';

/*
 * The people travelling on a booking. The customer enters them in the app; the company can complete or
 * correct them after seeing the passports at the office. Both edit the same list.
 */

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));
const isoDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة'), z.literal('')]).optional();

export const travelerSchema = z
  .object({
    id: z.string().trim().max(16).optional(),
    full_name: z.string().trim().min(3, 'اكتب الاسم كما في جواز السفر').max(255),
    traveler_type: z.enum(['adult', 'child']).default('adult'),
    gender: z.enum(['male', 'female', '']).optional(),
    birth_date: isoDate,
    nationality: optionalText(100),
    passport_number: optionalText(50),
    passport_expiry: isoDate,
    passport_image_url: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  .strict();

export const travelersBodySchema = z.object({ travelers: z.array(travelerSchema).max(60) }).strict();

export const TRAVELER_COLUMNS = `id, full_name, traveler_type, gender, birth_date, nationality, passport_number, passport_expiry,
  passport_image_url, added_by, created_at, updated_at`;

export const readTravelers = async (bookingId: string) => {
  const result = await pool.query(
    `SELECT ${TRAVELER_COLUMNS} FROM booking_travelers WHERE booking_id = $1 ORDER BY traveler_type ASC, created_at ASC`,
    [bookingId]
  );
  return result.rows;
};

export class TravelerError extends Error {}

/**
 * Replaces the booking's traveler list. Passport images must be files the saver uploaded, or ones already on
 * this booking's list (uploaded by the other side), so nobody can attach someone else's file.
 */
export const saveTravelers = async (
  req: Request,
  booking: any,
  travelers: z.infer<typeof travelerSchema>[],
  saver: { userId: string; type: 'customer' | 'company' }
) => {
  const adults = Number(booking.travelers_count || 0) - Number(booking.children_count || 0);
  const children = Number(booking.children_count || 0);
  const adultRows = travelers.filter((row) => row.traveler_type !== 'child').length;
  const childRows = travelers.filter((row) => row.traveler_type === 'child').length;
  if (adultRows > Math.max(adults, 0) || childRows > children) {
    throw new TravelerError(`الحجز لعدد ${adults} بالغ${children ? ` و${children} طفل` : ''}، لا يمكن إضافة مسافرين أكثر من ذلك`);
  }

  const current = await readTravelers(booking.id);
  const knownFiles = new Set(current.map((row: any) => String(row.passport_image_url || '').split('/').pop()).filter(Boolean));

  const rows = [];
  for (const row of travelers) {
    let image: string | null = null;
    if (row.passport_image_url) {
      const url = normalizeUploadUrl(row.passport_image_url, req);
      if (url === false) throw new TravelerError(`صورة جواز ${row.full_name} غير صالحة، ارفعها مرة أخرى`);
      if (url && knownFiles.has(url.split('/').pop())) image = url;
      else {
        const owned = await resolveUserUpload(url, req, saver.userId, null);
        if (owned === false) throw new TravelerError(`صورة جواز ${row.full_name} غير صالحة، ارفعها مرة أخرى`);
        image = owned || null;
      }
    }
    rows.push({ ...row, passport_image_url: image });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keepIds = rows.map((row) => row.id).filter(Boolean);
    await client.query(
      `DELETE FROM booking_travelers WHERE booking_id = $1 AND NOT (id = ANY($2::text[]))`,
      [booking.id, keepIds]
    );
    for (const row of rows) {
      const values = [
        row.full_name,
        row.traveler_type || 'adult',
        row.gender || null,
        row.birth_date || null,
        row.nationality || null,
        row.passport_number || null,
        row.passport_expiry || null,
        row.passport_image_url,
      ];
      const existing = row.id && current.some((item: any) => item.id === row.id);
      if (existing) {
        await client.query(
          `UPDATE booking_travelers SET full_name = $1, traveler_type = $2, gender = $3, birth_date = $4, nationality = $5,
             passport_number = $6, passport_expiry = $7, passport_image_url = $8, updated_at = NOW()
           WHERE id = $9 AND booking_id = $10`,
          [...values, row.id, booking.id]
        );
      } else {
        await client.query(
          `INSERT INTO booking_travelers (full_name, traveler_type, gender, birth_date, nationality, passport_number, passport_expiry,
             passport_image_url, id, booking_id, added_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [...values, generate16CharId(), booking.id, saver.type]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return readTravelers(booking.id);
};

// Whether every traveler of the booking has been entered with a passport number
export const travelersComplete = (booking: any, travelers: any[]) =>
  travelers.length >= Number(booking.travelers_count || 0) && travelers.every((row) => row.passport_number);
