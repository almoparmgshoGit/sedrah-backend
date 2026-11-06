import { Request, Response } from 'express';
import { pool } from '../config/db';
import { enrichPackage, PACKAGE_EXTRA_COLUMNS } from '../utils/packageInfo';
import { companyReadySql } from '../utils/companyReadiness';

export const searchPackages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { q, cityId, minPrice, maxPrice, rating, minNights, maxNights, months, ramadan, date, flights } = req.query;

    let query = `
      SELECT p.*, c.name as company_name, ci.name as city_name, ${PACKAGE_EXTRA_COLUMNS}
      FROM packages p
      JOIN companies c ON p.company_id = c.id
      JOIN cities ci ON p.city_id = ci.id
      WHERE (p.status = 'active' OR p.status IS NULL) AND ${companyReadySql('c')}
    `;
    let params: any[] = [];
    let paramIndex = 1;

    if (q) {
      query += ` AND (p.title ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex} OR ci.name ILIKE $${paramIndex})`;
      params.push(`%${q}%`);
      paramIndex++;
    }

    if (cityId) {
      query += ` AND p.city_id = $${paramIndex}`;
      params.push(String(cityId));
      paramIndex++;
    }

    if (minPrice) {
      query += ` AND p.price >= $${paramIndex}`;
      params.push(parseFloat(minPrice as string));
      paramIndex++;
    }

    if (maxPrice) {
      query += ` AND p.price <= $${paramIndex}`;
      params.push(parseFloat(maxPrice as string));
      paramIndex++;
    }

    if (rating) {
      query += ` AND c.rating >= $${paramIndex}`;
      params.push(parseFloat(rating as string));
      paramIndex++;
    }

    if (minNights) {
      query += ` AND p.nights_count >= $${paramIndex}`;
      params.push(parseInt(minNights as string, 10));
      paramIndex++;
    }

    if (maxNights) {
      query += ` AND p.nights_count <= $${paramIndex}`;
      params.push(parseInt(maxNights as string, 10));
      paramIndex++;
    }

    const travelConditions: string[] = [];
    const monthList = String(months || '').split(',').filter((m) => /^\d{2}$/.test(m));
    if (monthList.length > 0) {
      travelConditions.push(`substring(p.departure_date from 6 for 2) = ANY($${paramIndex})`);
      params.push(monthList);
      paramIndex++;
    }
    if (ramadan === 'true') {
      // The season the company picked; older packages without one still match by their title
      travelConditions.push(`(p.season = 'ramadan' OR (p.season IS NULL AND p.title ILIKE '%رمضان%'))`);
    }
    if (travelConditions.length > 0) {
      query += ` AND (${travelConditions.join(' OR ')})`;
    }

    if (date) {
      query += ` AND p.departure_date LIKE $${paramIndex}`;
      params.push(`${String(date).slice(0, 10)}%`);
      paramIndex++;
    }

    if (flights === 'true') {
      query += ` AND (p.includes_flight = TRUE OR (p.includes_flight IS NOT TRUE AND p.features ILIKE '%طيران%'))`;
    }

    query += ' ORDER BY p.created_at DESC';

    const result = await pool.query(query, params);
    res.json({
      success: true,
      data: result.rows.map(enrichPackage),
    });
  } catch (error: any) {
    console.error('Error searching packages:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء البحث والفلترة' });
  }
};
