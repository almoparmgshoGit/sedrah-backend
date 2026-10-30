import { Response } from 'express';
import { AuthRequest } from '../middlewares/permission.middleware';
import { pool } from '../config/db';
import { generate16CharId } from '../utils/formatId';

export const getCoupons = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'فشل جلب الكوبونات' });
  }
};

export const createCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      code,
      type, // 'product' or 'booking'
      discount_type, // 'percentage' or 'fixed'
      discount_value,
      min_order_amount,
      max_discount_amount,
      usage_limit,
      start_date,
      end_date,
      is_active,
      target_ids
    } = req.body;

    if (!code || !type || !discount_type || discount_value === undefined) {
      res.status(400).json({ success: false, message: 'جميع الحقول الأساسية مطلوبة' });
      return;
    }

    const cleanCode = String(code).trim().toUpperCase();
    const id = generate16CharId();
    const targetIdsStr = Array.isArray(target_ids) ? JSON.stringify(target_ids) : (target_ids ? String(target_ids) : '[]');

    const result = await pool.query(
      `INSERT INTO coupons (id, code, type, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit, start_date, end_date, is_active, target_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        cleanCode,
        type,
        discount_type,
        parseFloat(discount_value),
        min_order_amount ? parseFloat(min_order_amount) : 0,
        max_discount_amount ? parseFloat(max_discount_amount) : null,
        usage_limit ? parseInt(usage_limit, 10) : null,
        start_date || null,
        end_date || null,
        is_active !== undefined ? Boolean(is_active) : true,
        targetIdsStr
      ]
    );

    res.status(201).json({ success: true, message: 'تم إنشاء الكوبون بنجاح', data: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'فشل إنشاء الكوبون' });
  }
};

export const updateCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      code,
      type,
      discount_type,
      discount_value,
      min_order_amount,
      max_discount_amount,
      usage_limit,
      start_date,
      end_date,
      is_active,
      target_ids
    } = req.body;

    const targetIdsStr = Array.isArray(target_ids) ? JSON.stringify(target_ids) : (target_ids ? String(target_ids) : undefined);

    const result = await pool.query(
      `UPDATE coupons SET
        code = COALESCE(NULLIF($1, ''), code),
        type = COALESCE(NULLIF($2, ''), type),
        discount_type = COALESCE(NULLIF($3, ''), discount_type),
        discount_value = COALESCE($4, discount_value),
        min_order_amount = COALESCE($5, min_order_amount),
        max_discount_amount = COALESCE($6, max_discount_amount),
        usage_limit = COALESCE($7, usage_limit),
        start_date = COALESCE($8, start_date),
        end_date = COALESCE($9, end_date),
        is_active = COALESCE($10, is_active),
        target_ids = COALESCE($11, target_ids)
       WHERE id = $12
       RETURNING *`,
      [
        code ? String(code).trim().toUpperCase() : null,
        type || null,
        discount_type || null,
        discount_value !== undefined ? parseFloat(discount_value) : null,
        min_order_amount !== undefined ? parseFloat(min_order_amount) : null,
        max_discount_amount !== undefined ? parseFloat(max_discount_amount) : null,
        usage_limit !== undefined ? parseInt(usage_limit, 10) : null,
        start_date || null,
        end_date || null,
        is_active !== undefined ? Boolean(is_active) : null,
        targetIdsStr,
        id
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, message: 'الكوبون غير موجود' });
      return;
    }

    res.json({ success: true, message: 'تم تحديث الكوبون بنجاح', data: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'فشل تحديث الكوبون' });
  }
};

export const deleteCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM coupons WHERE id = $1', [id]);
    res.json({ success: true, message: 'تم حذف الكوبون بنجاح' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'فشل حذف الكوبون' });
  }
};

export const validateCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code, type, amount, target_ids } = req.body;

    if (!code || !type || amount === undefined) {
      res.status(400).json({ success: false, message: 'رمز الكوبون ونوع العملية والمبلغ مطلوبان' });
      return;
    }

    const cleanCode = String(code).trim().toUpperCase();
    const couponRes = await pool.query('SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE', [cleanCode]);

    if (couponRes.rows.length === 0) {
      res.status(404).json({ success: false, message: 'كوبون الخصم غير صالح أو منتهي الصلاحية' });
      return;
    }

    const coupon = couponRes.rows[0];

    if (coupon.type !== type) {
      res.status(400).json({
        success: false,
        message: coupon.type === 'product' ? 'هذا الكوبون خاص بمنتجات المتجر فقط ولا يمكن تطبيقه على الحجوزات' : 'هذا الكوبون خاص بالحجوزات فقط ولا يمكن تطبيقه على متجر المنتجات'
      });
      return;
    }

    const now = new Date();
    if (coupon.end_date && new Date(coupon.end_date) < now) {
      res.status(400).json({ success: false, message: 'عذراً، هذا الكوبون منتهي الصلاحية' });
      return;
    }
    if (coupon.start_date && new Date(coupon.start_date) > now) {
      res.status(400).json({ success: false, message: 'عذراً، هذا الكوبون لم يبدأ بعد' });
      return;
    }

    if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
      res.status(400).json({ success: false, message: 'عذراً، لقد استنفد هذا الكوبون الحد الأقصى للاستخدام' });
      return;
    }

    const orderAmount = parseFloat(amount) || 0;
    if (coupon.min_order_amount && orderAmount < parseFloat(coupon.min_order_amount)) {
      res.status(400).json({ success: false, message: `الحد الأدنى لتطبيق هذا الكوبون هو ${coupon.min_order_amount} ر.س` });
      return;
    }

    const targetIds = typeof coupon.target_ids === 'string' ? JSON.parse(coupon.target_ids || '[]') : (coupon.target_ids || []);
    if (Array.isArray(targetIds) && targetIds.length > 0 && Array.isArray(target_ids)) {
      const hasMatch = target_ids.some((id: any) => targetIds.includes(String(id)));
      if (!hasMatch) {
        res.status(400).json({ success: false, message: 'هذا الكوبون لا ينطبق على المنتجات أو الباقات المحددة' });
        return;
      }
    }

    let discountAmount = 0;
    if (coupon.discount_type === 'percentage') {
      discountAmount = (orderAmount * parseFloat(coupon.discount_value)) / 100;
      if (coupon.max_discount_amount && discountAmount > parseFloat(coupon.max_discount_amount)) {
        discountAmount = parseFloat(coupon.max_discount_amount);
      }
    } else {
      discountAmount = parseFloat(coupon.discount_value);
    }

    if (discountAmount > orderAmount) {
      discountAmount = orderAmount;
    }

    const finalAmount = orderAmount - discountAmount;

    res.json({
      success: true,
      message: 'تم تطبيق الكوبون بنجاح',
      data: {
        code: coupon.code,
        discount_type: coupon.discount_type,
        discount_value: coupon.discount_value,
        discount_amount: discountAmount,
        final_amount: finalAmount
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'فشل التحقق من الكوبون' });
  }
};
