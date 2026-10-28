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
        shipping_fee: gov.shipping_fee !== null && gov.shipping_fee !== undefined ? parseFloat(gov.shipping_fee) : 50.00,
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

export const updateGovernorateShipping = async (req: any, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { shipping_fee } = req.body;
    const fee = parseFloat(shipping_fee);
    if (isNaN(fee) || fee < 0) {
      res.status(400).json({ error: 'سعر الشحن غير صالح' });
      return;
    }
    const result = await pool.query(
      'UPDATE governorates SET shipping_fee = $1 WHERE id = $2 RETURNING *',
      [fee, id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'المحافظة غير موجودة' });
      return;
    }
    res.json({ success: true, message: 'تم تحديث سعر الشحن بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating governorate shipping:', error);
    res.status(500).json({ error: 'فشل تحديث سعر الشحن' });
  }
};
