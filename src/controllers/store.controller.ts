import { Request, Response } from 'express';
import { pool } from '../config/db';
import { generate16CharId } from '../utils/formatId';
import { createAndSendNotification } from '../utils/notificationHelper';

function generateOrderNumber(): string {
  const randomHex = Math.floor(100000 + Math.random() * 900000).toString(16).toUpperCase();
  return `ORD-${randomHex}`;
}

export const getCategories = async (_req: Request, res: Response) => {
  try {
    await pool.query(`DELETE FROM store_categories a USING store_categories b WHERE a.id > b.id AND a.name = b.name;`).catch(() => {});

    const DEFAULT_CATS = [
      { name: 'ملابس الإحرام', icon: 'shirt-outline', sort_order: 1 },
      { name: 'ملابس النساء', icon: 'woman-outline', sort_order: 2 },
      { name: 'مستلزمات العمرة', icon: 'home-outline', sort_order: 3 },
      { name: 'مستلزمات السفر', icon: 'briefcase-outline', sort_order: 4 },
    ];
    for (const cat of DEFAULT_CATS) {
      await pool.query(
        'INSERT INTO store_categories (id, name, icon, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING',
        [generate16CharId(), cat.name, cat.icon, cat.sort_order]
      );
    }

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

    const products = result.rows.map((p) => ({
      ...p,
      images: typeof p.images === 'string' ? JSON.parse(p.images || '[]') : p.images,
      sizes: typeof p.sizes === 'string' ? JSON.parse(p.sizes || '[]') : p.sizes,
      colors: typeof p.colors === 'string' ? JSON.parse(p.colors || '[]') : p.colors,
    }));

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

    const p = result.rows[0];
    p.images = typeof p.images === 'string' ? JSON.parse(p.images || '[]') : p.images;
    p.sizes = typeof p.sizes === 'string' ? JSON.parse(p.sizes || '[]') : p.sizes;
    p.colors = typeof p.colors === 'string' ? JSON.parse(p.colors || '[]') : p.colors;

    return res.json({ success: true, data: p });
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
      shipping_fee = 0,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'السلة فارغة' });
    }

    if (!customer_name || !customer_phone || !customer_address) {
      return res.status(400).json({ success: false, message: 'يرجى إكمال بيانات العميل (الاسم، الهاتف، العنوان)' });
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
      const itemPrice = parseFloat(prod.discount_price || prod.price);
      const qty = parseInt(item.quantity, 10) || 1;
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

      if (prod.stock >= qty) {
        await client.query('UPDATE store_products SET stock = stock - $1 WHERE id = $2', [qty, prod.id]);
      }
    }

    const orderNumber = generateOrderNumber();
    const finalShippingFee = parseFloat(shipping_fee) || 0;
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
    return res.status(500).json({ success: false, message: error.message || 'حدث خطأ أثناء إنشاء الطلب' });
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
