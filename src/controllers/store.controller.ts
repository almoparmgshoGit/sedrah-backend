import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db';
import { generate16CharId } from '../utils/formatId';
import { createAndSendNotification } from '../utils/notificationHelper';
import { createAdminAlert } from '../utils/adminAlerts';
import { applyVariantStockChange, parseProductRow } from '../utils/productStock';

const MAX_ORDER_LINES = 50;
const MAX_ITEM_QUANTITY = 100;

// Mirrors the fee published by getGovernorates, so the charged amount never comes from the client
const calculateShippingFee = async (client: any, governorateId: unknown): Promise<number> => {
  const settingsRes = await client.query("SELECT key, value FROM settings WHERE key IN ('shipping_mode', 'unified_shipping_fee')");
  const settings: Record<string, string> = {};
  for (const row of settingsRes.rows) settings[row.key] = row.value;

  if ((settings['shipping_mode'] || 'unified') === 'unified') {
    return parseFloat(settings['unified_shipping_fee'] ?? '50') || 0;
  }

  const govRes = governorateId
    ? await client.query('SELECT shipping_fee FROM governorates WHERE id = $1', [String(governorateId)])
    : { rows: [] };
  const fee = govRes.rows[0]?.shipping_fee;
  return fee !== null && fee !== undefined ? parseFloat(fee) : 50;
};

function generateOrderNumber(): string {
  return `ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const parseJsonArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Same rule as the product screen: a color with its own price overrides the product price
const resolveItemPrice = (product: any, color: unknown): number => {
  const colorName = typeof color === 'object' && color !== null ? (color as any).name : color;
  if (colorName) {
    const match = parseJsonArray(product.colors).find((c: any) => (typeof c === 'object' && c !== null ? c.name : c) === colorName);
    const colorPrice = match && typeof match === 'object' ? Number(match.price) : 0;
    if (colorPrice > 0) return colorPrice;
  }
  return parseFloat(product.discount_price || product.price);
};

export const getCategories = async (_req: Request, res: Response) => {
  try {
    // Default categories are seeded once at startup when the table is empty, never on read,
    // so categories the admin deletes or renames stay that way
    const result = await pool.query(
      `SELECT * FROM store_categories WHERE is_active = TRUE ORDER BY sort_order ASC, created_at ASC`
    );
    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ في جلب الأقسام' });
  }
};

export const getProducts = async (req: Request, res: Response) => {
  try {
    const { category_id, search, is_featured, min_price, max_price } = req.query;

    let query = `SELECT p.*, c.name as category_name
                 FROM store_products p
                 LEFT JOIN store_categories c ON p.category_id = c.id
                 WHERE p.is_active = TRUE`;
    const params: any[] = [];

    if (category_id) {
      params.push(category_id);
      query += ` AND p.category_id = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR p.custom_id ILIKE $${params.length})`;
    }

    if (is_featured === 'true') {
      query += ` AND p.is_featured = TRUE`;
    }

    if (min_price) {
      params.push(min_price);
      query += ` AND COALESCE(p.discount_price, p.price) >= $${params.length}`;
    }

    if (max_price) {
      params.push(max_price);
      query += ` AND COALESCE(p.discount_price, p.price) <= $${params.length}`;
    }

    query += ` ORDER BY p.created_at DESC`;

    const result = await pool.query(query, params);

    const products = result.rows.map(parseProductRow);

    return res.json({ success: true, data: products });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ في جلب المنتجات' });
  }
};

export const getProductById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT p.*, c.name as category_name
       FROM store_products p
       LEFT JOIN store_categories c ON p.category_id = c.id
       WHERE (p.id = $1 OR p.custom_id = $1) AND p.is_active = TRUE`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    }

    return res.json({ success: true, data: parseProductRow(result.rows[0]) });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ في جلب بيانات المنتج' });
  }
};

export const getBanners = async (req: Request, res: Response) => {
  try {
    const { governorate_id } = req.query;

    let query = `
      SELECT b.*, p.name as product_name, p.custom_id as linked_custom_id
      FROM store_banners b
      LEFT JOIN store_products p ON b.product_id = p.id
      WHERE b.is_active = TRUE
      AND (b.start_at IS NULL OR b.start_at <= NOW())
      AND (b.end_at IS NULL OR b.end_at >= NOW())
      AND (b.start_date IS NULL OR b.start_date <= CURRENT_DATE)
      AND (b.end_date IS NULL OR b.end_date >= CURRENT_DATE)
    `;
    const params: any[] = [];

    if (governorate_id) {
      params.push(governorate_id);
      query += ` AND (b.governorate_id IS NULL OR b.governorate_id = $${params.length})`;
    }

    query += ` ORDER BY b.created_at DESC`;

    const result = await pool.query(query, params);
    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ في جلب البانرات' });
  }
};

export const createOrder = async (req: any, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = req.user?.id;
    const {
      customer_name,
      customer_phone,
      customer_address,
      governorate_id,
      city_id,
      notes,
      items,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'السلة فارغة' });
    }

    if (items.length > MAX_ORDER_LINES) {
      return res.status(400).json({ success: false, message: 'عدد المنتجات في الطلب كبير جداً' });
    }

    const hasInvalidQuantity = items.some((item: any) => {
      const qty = item?.quantity === undefined ? 1 : Number(item.quantity);
      return !Number.isInteger(qty) || qty < 1 || qty > MAX_ITEM_QUANTITY;
    });
    if (hasInvalidQuantity) {
      return res.status(400).json({ success: false, message: 'كمية المنتج غير صالحة' });
    }

    if (!customer_name || !customer_phone || !customer_address
      || typeof customer_name !== 'string' || typeof customer_phone !== 'string' || typeof customer_address !== 'string') {
      return res.status(400).json({ success: false, message: 'يرجى إكمال بيانات العميل (الاسم، الهاتف، العنوان)' });
    }
    if (customer_name.length > 255 || customer_address.length > 1000 || (notes && String(notes).length > 2000)
      || !/^\+?[0-9\s-]{7,20}$/.test(customer_phone.trim())) {
      return res.status(400).json({ success: false, message: 'بيانات العميل غير صالحة، تأكد من رقم الهاتف والعنوان' });
    }

    await client.query('BEGIN');

    if (userId) {
      let cityName = null;
      if (city_id) {
        const cityRes = await client.query('SELECT name FROM cities WHERE id = $1', [city_id]);
        if (cityRes.rows.length > 0) cityName = cityRes.rows[0].name;
      }
      if (!cityName && customer_address) {
        cityName = customer_address.split('-')[0].trim();
      }

      await client.query(
        `UPDATE users
         SET name = COALESCE(NULLIF(name, ''), $1),
             phone = COALESCE(NULLIF(phone, ''), $2),
             address = COALESCE(NULLIF(address, ''), $3),
             city = COALESCE(NULLIF(city, ''), $5)
         WHERE id = $4`,
        [customer_name, customer_phone, customer_address, userId, cityName]
      );
    }

    let subtotal = 0;
    const preparedItems: any[] = [];

    for (const item of items) {
      const prodRes = await client.query('SELECT * FROM store_products WHERE id = $1 AND is_active = TRUE', [item.product_id]);
      if (prodRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `المنتج رقم ${item.product_id} غير متوفر` });
      }

      const prod = prodRes.rows[0];
      const itemPrice = resolveItemPrice(prod, item.color);
      const qty = item.quantity === undefined ? 1 : Number(item.quantity);
      const itemTotal = itemPrice * qty;

      subtotal += itemTotal;

      const sizeStr = typeof item.size === 'object' && item.size !== null ? (item.size.name || JSON.stringify(item.size)) : (item.size ? String(item.size) : null);
      const colorStr = typeof item.color === 'object' && item.color !== null ? (item.color.name || JSON.stringify(item.color)) : (item.color ? String(item.color) : null);

      preparedItems.push({
        product_id: prod.id,
        product_name: prod.name,
        price: itemPrice,
        quantity: qty,
        size: sizeStr,
        color: colorStr,
        total_price: itemTotal,
      });

      // Row-locked so concurrent orders cannot both take the last unit of the same color/size
      const stockRes = await applyVariantStockChange(client, prod.id, colorStr, sizeStr, -qty);
      if (!stockRes || !stockRes.ok) {
        await client.query('ROLLBACK');
        const variantLabel = [colorStr, sizeStr].filter(Boolean).join(' / ');
        const message = stockRes && !stockRes.ok && stockRes.reason === 'unknown_variant'
          ? `الاختيار "${variantLabel}" من "${prod.name}" لم يعد متوفراً`
          : stockRes && !stockRes.ok && stockRes.available > 0
          ? `المتوفر من "${prod.name}"${variantLabel ? ` (${variantLabel})` : ''} ${stockRes.available} قطعة فقط`
          : `"${prod.name}"${variantLabel ? ` (${variantLabel})` : ''} نفدت الكمية`;
        return res.status(400).json({ success: false, message });
      }
    }

    const orderNumber = generateOrderNumber();
    const finalShippingFee = await calculateShippingFee(client, governorate_id);
    const grandTotal = subtotal + finalShippingFee;

    const orderRes = await client.query(
      `INSERT INTO store_orders
       (id, order_number, user_id, customer_name, customer_phone, customer_address, governorate_id, city_id, subtotal, shipping_fee, total, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
       RETURNING *`,
      [
        generate16CharId(),
        orderNumber,
        userId || null,
        customer_name,
        customer_phone,
        customer_address,
        governorate_id || null,
        city_id || null,
        subtotal,
        finalShippingFee,
        grandTotal,
        notes || null,
      ]
    );

    const createdOrder = orderRes.rows[0];

    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO store_order_items (id, order_id, product_id, product_name, price, quantity, size, color, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          generate16CharId(),
          createdOrder.id,
          item.product_id,
          item.product_name,
          item.price,
          item.quantity,
          item.size,
          item.color,
          item.total_price,
        ]
      );
    }

    await client.query('COMMIT');

    // Sent only after the order is committed, so a failed order never produces a "received" notification
    if (userId) {
      await createAndSendNotification({
        userId,
        title: 'طلب متجر جديد',
        subtitle: `تم استلام طلبك بنجاح برقم #${orderNumber}`,
        category: 'store',
        icon: 'bag-outline',
        iconBg: '#ECFDF5',
        iconColor: '#059669',
        data: { type: 'order_created', orderNumber, orderId: createdOrder.id },
      });
    }

    await createAdminAlert({
      type: 'store_order',
      module: 'store',
      title: 'طلب متجر جديد',
      body: `${customer_name || 'عميل'} طلب #${orderNumber} بإجمالي ${grandTotal}`,
      entityType: 'store_order',
      entityId: createdOrder.id,
      link: `/store?tab=orders&order=${createdOrder.id}`,
      requiresAction: true,
    });

    return res.status(201).json({
      success: true,
      message: 'تم إنشاء الطلب بنجاح',
      data: {
        order_number: createdOrder.order_number,
        id: createdOrder.id,
        total: grandTotal,
      },
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', error);
    return res.status(500).json({ success: false, message: 'حدث خطأ أثناء إنشاء الطلب' });
  } finally {
    client.release();
  }
};

export const getUserOrders = async (req: any, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'غير مصرح' });
    }

    const ordersRes = await pool.query(
      `SELECT o.*,
              (SELECT JSON_AGG(i.*) FROM store_order_items i WHERE i.order_id = o.id) as items
       FROM store_orders o
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
      [userId]
    );

    return res.json({ success: true, data: ordersRes.rows });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ في جلب طلباتك' });
  }
};

export const getOrderDetails = async (req: any, res: Response) => {
  try {
    const { orderIdentifier } = req.params;
    const userId = req.user?.id;

    const result = await pool.query(
      `SELECT o.*,
              (SELECT JSON_AGG(i.*) FROM store_order_items i WHERE i.order_id = o.id) as items
       FROM store_orders o
       WHERE (o.order_number = $1 OR o.id = $1)
       AND ($2::text IS NULL OR o.user_id = $2)`,
      [orderIdentifier, userId || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ في جلب تفاصيل الطلب' });
  }
};
