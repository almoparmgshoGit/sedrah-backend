import { Request, Response } from 'express';
import { pool } from '../config/db';

export const getGovernorates = async (req: Request, res: Response): Promise<void> => {
  try {
    const settingsRes = await pool.query("SELECT key, value FROM settings WHERE key IN ('shipping_mode', 'unified_shipping_fee')");
    const settingsMap: Record<string, string> = {};
    for (const row of settingsRes.rows) {
      settingsMap[row.key] = row.value;
    }

    const shippingMode = settingsMap['shipping_mode'] || 'unified';
    const unifiedFee = parseFloat(settingsMap['unified_shipping_fee'] ?? '50') || 0;

    const govRes = await pool.query('SELECT * FROM governorates ORDER BY id ASC');
    const governorates = [];

    for (const gov of govRes.rows) {
      const centersRes = await pool.query('SELECT name FROM centers WHERE governorate_id = $1 ORDER BY id ASC', [gov.id]);
      const fee = shippingMode === 'unified'
        ? unifiedFee
        : (gov.shipping_fee !== null && gov.shipping_fee !== undefined ? parseFloat(gov.shipping_fee) : 50.00);

      governorates.push({
        id: gov.id,
        name: gov.name,
        shipping_fee: fee,
        centers: centersRes.rows.map(c => c.name),
      });
    }

    res.json({
      success: true,
      data: governorates,
      shipping_mode: shippingMode,
      unified_shipping_fee: unifiedFee,
    });
  } catch (error: any) {
    console.error('Error fetching governorates:', error);
    res.status(500).json({ error: 'فشل جلب المحافظات والمراكز' });
  }
};

export const getShippingConfig = async (req: any, res: Response): Promise<void> => {
  try {
    const settingsRes = await pool.query("SELECT key, value FROM settings WHERE key IN ('shipping_mode', 'unified_shipping_fee')");
    const settingsMap: Record<string, string> = {};
    for (const row of settingsRes.rows) {
      settingsMap[row.key] = row.value;
    }

    const govRes = await pool.query('SELECT * FROM governorates ORDER BY id ASC');

    res.json({
      success: true,
      data: {
        shipping_mode: settingsMap['shipping_mode'] || 'unified',
        unified_shipping_fee: parseFloat(settingsMap['unified_shipping_fee'] ?? '50') || 0,
        governorates: govRes.rows.map(g => ({
          id: g.id,
          name: g.name,
          shipping_fee: g.shipping_fee !== null && g.shipping_fee !== undefined ? parseFloat(g.shipping_fee) : 50.00,
        })),
      },
    });
  } catch (error: any) {
    console.error('Error fetching shipping config:', error);
    res.status(500).json({ error: 'فشل جلب إعدادات الشحن' });
  }
};

export const updateShippingConfig = async (req: any, res: Response): Promise<void> => {
  try {
    const { shipping_mode, unified_shipping_fee } = req.body;
    if (shipping_mode) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['shipping_mode', String(shipping_mode)]
      );
    }
    if (unified_shipping_fee !== undefined) {
      const fee = parseFloat(unified_shipping_fee);
      if (!isNaN(fee) && fee >= 0) {
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          ['unified_shipping_fee', String(fee)]
        );
      }
    }
    res.json({ success: true, message: 'تم تحديث إعدادات الشحن بنجاح' });
  } catch (error: any) {
    console.error('Error updating shipping config:', error);
    res.status(500).json({ error: 'فشل تحديث إعدادات الشحن' });
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
