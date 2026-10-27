import { Request, Response } from 'express';
import { pool } from '../config/db';

export const searchPackages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { q, cityId, minPrice, maxPrice, rating } = req.query;

    let query = `
      SELECT p.*, c.name as company_name, ci.name as city_name
      FROM packages p
      JOIN companies c ON p.company_id = c.id
      JOIN cities ci ON p.city_id = ci.id
      WHERE 1=1
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
      query += ` AND p.rating >= $${paramIndex}`;
      params.push(parseFloat(rating as string));
      paramIndex++;
    }

    query += ' ORDER BY p.created_at DESC';

    const result = await pool.query(query, params);
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error searching packages:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء البحث والفلترة' });
  }
};
