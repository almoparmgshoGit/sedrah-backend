import { Request, Response } from 'express';
import { pool } from '../config/db';
import { parseIdOrToken, generate16CharId } from '../utils/formatId';

const resolveCompanyId = async (rawId: any): Promise<string | null> => {
  if (!rawId) return null;
  try {
    const parsed = parseIdOrToken(rawId);
    let compRes;
    if (parsed.isToken) {
      compRes = await pool.query(
        'SELECT id FROM companies WHERE public_id = $1 OR id = $1',
        [parsed.value]
      );
    } else {
      compRes = await pool.query(
        'SELECT id FROM companies WHERE id = $1 OR public_id = $2',
        [parsed.value, String(rawId)]
      );
    }
    return compRes.rows.length > 0 ? compRes.rows[0].id : null;
  } catch {
    return null;
  }
};

const resolvePackageId = async (rawId: any): Promise<string | null> => {
  if (!rawId) return null;
  try {
    const parsed = parseIdOrToken(rawId);
    let pkgRes;
    if (parsed.isToken) {
      pkgRes = await pool.query(
        'SELECT id FROM packages WHERE public_id = $1 OR id = $1',
        [parsed.value]
      );
    } else {
      pkgRes = await pool.query(
        'SELECT id FROM packages WHERE id = $1 OR public_id = $2',
        [parsed.value, String(rawId)]
      );
    }
    return pkgRes.rows.length > 0 ? pkgRes.rows[0].id : null;
  } catch {
    return null;
  }
};

export const getUserFavorites = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const favoritesResult = await pool.query(
      `
      SELECT f.id as favorite_id, f.company_id, f.package_id, f.product_id, f.product_name, f.product_price, f.product_image,
             c.name as company_name, c.logo_url as company_logo, c.rating as company_rating, c.reviews_count, c.verified,
             p.title as package_title, p.price as package_price, p.duration as package_duration, p.image_url as package_image
      FROM favorites f
      LEFT JOIN companies c ON f.company_id = c.id
      LEFT JOIN packages p ON f.package_id = p.id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
      `,
      [String(userId)]
    );

    res.json({
      success: true,
      data: favoritesResult.rows,
    });
  } catch (error: any) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب المفضلة' });
  }
};

export const addFavorite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    const body = req.body || {};

    const rawCompanyId = body.companyId !== undefined ? body.companyId : (body.company_id !== undefined ? body.company_id : req.query.companyId || req.query.company_id || null);
    const rawPackageId = body.packageId !== undefined ? body.packageId : (body.package_id !== undefined ? body.package_id : req.query.packageId || req.query.package_id || null);
    const targetProductId = body.productId !== undefined ? body.productId : (body.product_id !== undefined ? body.product_id : req.query.productId || req.query.product_id || null);

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    if (!rawCompanyId && !rawPackageId && !targetProductId) {
      res.status(400).json({ error: 'بيانات المفضلة غير مكتملة' });
      return;
    }

    const finalCompanyId = await resolveCompanyId(rawCompanyId);
    const finalPackageId = await resolvePackageId(rawPackageId);
    const finalProductId = targetProductId;

    // Check if already favorited
    const existing = await pool.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND ((company_id = $2 AND $2 IS NOT NULL) OR (package_id = $3 AND $3 IS NOT NULL) OR (product_id = $4 AND $4 IS NOT NULL))',
      [userId, finalCompanyId, finalPackageId, finalProductId]
    );

    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'العنصر موجود بالفعل في المفضلة' });
      return;
    }

    const result = await pool.query(
      'INSERT INTO favorites (id, user_id, company_id, package_id, product_id, product_name, product_price, product_image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [generate16CharId(), userId, finalCompanyId, finalPackageId, finalProductId, body.productName || body.product_name || null, body.productPrice || body.product_price || null, body.productImage || body.product_image || null]
    );

    res.status(201).json({
      success: true,
      message: 'تمت الإضافة إلى المفضلة بنجاح',
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error adding favorite:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء الإضافة للمفضلة' });
  }
};

export const removeFavorite = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    const favoriteId = req.params.id;

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const result = await pool.query(
      'DELETE FROM favorites WHERE id = $1 AND user_id = $2 RETURNING *',
      [favoriteId, userId]
    );

    res.json({
      success: true,
      message: 'تم الحذف من المفضلة بنجاح',
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error removing favorite:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء الحذف من المفضلة' });
  }
};
