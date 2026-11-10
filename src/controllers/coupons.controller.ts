import { Response } from 'express';
import { AuthRequest } from '../middlewares/security.middleware';
import { pool } from '../config/db';
import { generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';

type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

// A field left out keeps its value (undefined), while an empty string clears it (null)
const isBlank = (value: unknown) => value === null || (typeof value === 'string' && value.trim() === '');

class CouponInputError extends Error {}

const parseOptionalNumber = (value: unknown, label: string, opts: { min?: number; integer?: boolean } = {}): number | null | undefined => {
  if (value === undefined) return undefined;
  if (isBlank(value)) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new CouponInputError(`قيمة ${label} غير صالحة`);
  if (opts.integer && !Number.isInteger(num)) throw new CouponInputError(`${label} يجب أن يكون رقماً صحيحاً`);
  if (opts.min !== undefined && num < opts.min) throw new CouponInputError(`${label} يجب ألا يقل عن ${opts.min}`);
  return num;
};

const parseOptionalDate = (value: unknown, label: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (isBlank(value)) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new CouponInputError(`${label} غير صالح`);
  return String(value);
};

const parseBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return !(value === false || value === 'false' || value === 0 || value === '0');
};

// Reads the coupon fields of the request body; only the fields that were sent are returned
const readCouponInput = (body: any) => {
  const input: Record<string, any> = {};
  if (body.code !== undefined && !isBlank(body.code)) input.code = String(body.code).trim().toUpperCase().slice(0, 50);
  if (body.type !== undefined && !isBlank(body.type)) {
    if (!['product', 'booking'].includes(body.type)) throw new CouponInputError('نوع الكوبون غير صالح');
    input.type = body.type;
  }
  if (body.discount_type !== undefined && !isBlank(body.discount_type)) {
    if (!['percentage', 'fixed'].includes(body.discount_type)) throw new CouponInputError('نوع الخصم غير صالح');
    input.discount_type = body.discount_type;
  }
  if (body.discount_value !== undefined) {
    const value = Number(body.discount_value);
    if (isBlank(body.discount_value) || !Number.isFinite(value) || value <= 0) throw new CouponInputError('قيمة الخصم يجب أن تكون رقماً أكبر من صفر');
    input.discount_value = value;
  }
  const minOrder = parseOptionalNumber(body.min_order_amount !== undefined ? body.min_order_amount : body.min_order, 'الحد الأدنى للطلب', { min: 0 });
  if (minOrder !== undefined) input.min_order_amount = minOrder;
  const maxDiscount = parseOptionalNumber(body.max_discount_amount, 'الحد الأقصى للخصم', { min: 0 });
  if (maxDiscount !== undefined) input.max_discount_amount = maxDiscount;
  const usageLimit = parseOptionalNumber(body.usage_limit, 'حد الاستخدام', { min: 1, integer: true });
  if (usageLimit !== undefined) input.usage_limit = usageLimit;
  const startDate = parseOptionalDate(body.start_date, 'تاريخ البداية');
  if (startDate !== undefined) input.start_date = startDate;
  const endDate = parseOptionalDate(body.end_date, 'تاريخ الانتهاء');
  if (endDate !== undefined) input.end_date = endDate;
  const isActive = parseBoolean(body.is_active);
  if (isActive !== undefined) input.is_active = isActive;
  if (body.target_ids !== undefined) {
    input.target_ids = Array.isArray(body.target_ids)
      ? JSON.stringify(body.target_ids.map(String))
      : isBlank(body.target_ids) ? '[]' : String(body.target_ids);
  }
  return input;
};

// Checks the rules that depend on several fields, on the coupon as it will be saved
const checkCouponRules = (coupon: Record<string, any>) => {
  if (coupon.discount_type === 'percentage' && Number(coupon.discount_value) > 100) {
    throw new CouponInputError('نسبة الخصم يجب ألا تتجاوز 100%');
  }
  if (coupon.start_date && coupon.end_date && new Date(coupon.end_date).getTime() < new Date(coupon.start_date).getTime()) {
    throw new CouponInputError('تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية');
  }
};

/**
 * Counts one use of a coupon, only while it is under its usage limit. Call it inside the transaction that
 * creates the booking or order; false means the coupon ran out and the caller should refuse it.
 */
export const redeemCoupon = async (client: Queryable, couponId: string): Promise<boolean> => {
  const result = await client.query(
    `UPDATE coupons SET used_count = COALESCE(used_count, 0) + 1
     WHERE id = $1 AND (usage_limit IS NULL OR COALESCE(used_count, 0) < usage_limit)
     RETURNING id`,
    [couponId]
  );
  return result.rows.length > 0;
};

export const getCoupons = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Get coupons error:', error);
    res.status(500).json({ success: false, error: 'فشل جلب الكوبونات' });
  }
};

export const createCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let input: Record<string, any>;
    try {
      input = readCouponInput(req.body || {});
      if (!input.type || !input.discount_type || input.discount_value === undefined) {
        throw new CouponInputError('نوع الكوبون ونوع وقيمة الخصم مطلوبان');
      }
      checkCouponRules(input);
    } catch (err) {
      if (err instanceof CouponInputError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      throw err;
    }

    const cleanCode = input.code || 'SDRA' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const id = generate16CharId();

    const result = await pool.query(
      `INSERT INTO coupons (id, code, type, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit, start_date, end_date, is_active, target_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        cleanCode,
        input.type,
        input.discount_type,
        input.discount_value,
        input.min_order_amount ?? null,
        input.max_discount_amount ?? null,
        input.usage_limit ?? null,
        input.start_date ?? null,
        input.end_date ?? null,
        input.is_active ?? true,
        input.target_ids ?? '[]',
      ]
    );

    await logAudit(req.user?.email || 'admin', 'إنشاء كوبون خصم', `الكوبون ${cleanCode}`, req.ip, req.user?.email, null, result.rows[0]);
    res.status(201).json({ success: true, message: 'تم إنشاء الكوبون بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Create coupon error:', error);
    if (error?.code === '23505') {
      res.status(409).json({ success: false, error: 'رمز الكوبون مستخدم مسبقاً' });
      return;
    }
    res.status(500).json({ success: false, error: 'فشل إنشاء الكوبون' });
  }
};

const UPDATABLE_FIELDS = [
  'code', 'type', 'discount_type', 'discount_value', 'min_order_amount', 'max_discount_amount',
  'usage_limit', 'start_date', 'end_date', 'is_active', 'target_ids',
];

export const updateCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const existingRes = await pool.query('SELECT * FROM coupons WHERE id = $1', [id]);
    const existing = existingRes.rows[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'الكوبون غير موجود' });
      return;
    }

    let input: Record<string, any>;
    try {
      input = readCouponInput(req.body || {});
      checkCouponRules({ ...existing, ...input });
    } catch (err) {
      if (err instanceof CouponInputError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      throw err;
    }

    // Only the fields that were sent are written, so an empty string really clears the value
    const fields = UPDATABLE_FIELDS.filter((field) => input[field] !== undefined);
    if (fields.length === 0) {
      res.json({ success: true, message: 'لا توجد تغييرات', data: existing });
      return;
    }
    const sets = fields.map((field, i) => `${field} = $${i + 1}`);
    const result = await pool.query(
      `UPDATE coupons SET ${sets.join(', ')} WHERE id = $${fields.length + 1} RETURNING *`,
      [...fields.map((field) => input[field]), id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'الكوبون غير موجود' });
      return;
    }

    await logAudit(req.user?.email || 'admin', 'تعديل كوبون خصم', `الكوبون ${result.rows[0].code}`, req.ip, req.user?.email, existing, result.rows[0]);
    res.json({ success: true, message: 'تم تحديث الكوبون بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Update coupon error:', error);
    if (error?.code === '23505') {
      res.status(409).json({ success: false, error: 'رمز الكوبون مستخدم مسبقاً' });
      return;
    }
    res.status(500).json({ success: false, error: 'فشل تحديث الكوبون' });
  }
};

export const deleteCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM coupons WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'الكوبون غير موجود' });
      return;
    }
    await logAudit(req.user?.email || 'admin', 'حذف كوبون خصم', `الكوبون ${result.rows[0].code}`, req.ip, req.user?.email, result.rows[0], null);
    res.json({ success: true, message: 'تم حذف الكوبون بنجاح' });
  } catch (error: any) {
    console.error('Delete coupon error:', error);
    res.status(500).json({ success: false, error: 'فشل حذف الكوبون' });
  }
};

export const validateCoupon = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code, type, amount, target_ids } = req.body;

    if (!code || !type || amount === undefined) {
      res.status(400).json({ success: false, error: 'رمز الكوبون ونوع العملية والمبلغ مطلوبان' });
      return;
    }

    const cleanCode = String(code).trim().toUpperCase();
    // The coupon stays valid through the whole of its end date
    const couponRes = await pool.query(
      `SELECT *,
         (end_date IS NOT NULL AND end_date::date < CURRENT_DATE) AS is_expired,
         (start_date IS NOT NULL AND start_date > NOW()) AS not_started
       FROM coupons WHERE code = $1 AND is_active = TRUE`,
      [cleanCode]
    );

    if (couponRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'كوبون الخصم غير صالح أو منتهي الصلاحية' });
      return;
    }

    const coupon = couponRes.rows[0];

    if (coupon.type !== type) {
      res.status(400).json({
        success: false,
        error: coupon.type === 'product' ? 'هذا الكوبون خاص بمنتجات المتجر فقط ولا يمكن تطبيقه على الحجوزات' : 'هذا الكوبون خاص بالحجوزات فقط ولا يمكن تطبيقه على متجر المنتجات'
      });
      return;
    }

    if (coupon.is_expired) {
      res.status(400).json({ success: false, error: 'عذراً، هذا الكوبون منتهي الصلاحية' });
      return;
    }
    if (coupon.not_started) {
      res.status(400).json({ success: false, error: 'عذراً، هذا الكوبون لم يبدأ بعد' });
      return;
    }

    if (coupon.usage_limit !== null && coupon.usage_limit !== undefined && Number(coupon.used_count || 0) >= Number(coupon.usage_limit)) {
      res.status(400).json({ success: false, error: 'عذراً، لقد استنفد هذا الكوبون الحد الأقصى للاستخدام' });
      return;
    }

    const orderAmount = Number(amount);
    if (!Number.isFinite(orderAmount) || orderAmount < 0) {
      res.status(400).json({ success: false, error: 'المبلغ غير صالح' });
      return;
    }
    if (coupon.min_order_amount && orderAmount < parseFloat(coupon.min_order_amount)) {
      res.status(400).json({ success: false, error: `الحد الأدنى لتطبيق هذا الكوبون هو ${coupon.min_order_amount} ر.س` });
      return;
    }

    let targetIds: any = [];
    try {
      targetIds = typeof coupon.target_ids === 'string' ? JSON.parse(coupon.target_ids || '[]') : (coupon.target_ids || []);
    } catch {
      targetIds = [];
    }
    if (Array.isArray(targetIds) && targetIds.length > 0 && Array.isArray(target_ids)) {
      const hasMatch = target_ids.some((id: any) => targetIds.includes(String(id)));
      if (!hasMatch) {
        res.status(400).json({ success: false, error: 'هذا الكوبون لا ينطبق على المنتجات أو الباقات المحددة' });
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
    console.error('Validate coupon error:', error);
    res.status(500).json({ success: false, error: 'فشل التحقق من الكوبون' });
  }
};
