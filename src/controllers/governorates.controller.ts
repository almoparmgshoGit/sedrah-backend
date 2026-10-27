import { Request, Response } from 'express';
import { pool } from '../config/db';

export const getGovernorates = async (req: Request, res: Response): Promise<void> => {
  try {
    const govRes = await pool.query('SELECT * FROM governorates ORDER BY id ASC');
    const governorates = [];

    for (const gov of govRes.rows) {
      const centersRes = await pool.query('SELECT name FROM centers WHERE governorate_id = $1 ORDER BY id ASC', [gov.id]);
      governorates.push({
        id: gov.id,
        name: gov.name,
        centers: centersRes.rows.map(c => c.name),
      });
    }

    res.json({
      success: true,
      data: governorates,
    });
  } catch (error: any) {
    console.error('Error fetching governorates:', error);
    res.status(500).json({ error: 'فشل جلب المحافظات والمراكز' });
  }
};
