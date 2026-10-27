import { Request, Response } from 'express';
import { pool } from '../config/db';
import { generate16CharId, generateRandomToken } from '../utils/formatId';

export const getCities = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.image_url,
        c.description,
        c.created_at,
        COALESCE(comp.total_companies, 0)::INTEGER AS total_companies,
        COALESCE(pkg.total_packages, 0)::INTEGER AS total_packages
      FROM cities c
      LEFT JOIN (
        SELECT city_id, COUNT(*)::INTEGER AS total_companies
        FROM companies
        WHERE city_id IS NOT NULL
        GROUP BY city_id
      ) comp ON c.id = comp.city_id
      LEFT JOIN (
        SELECT city_id, COUNT(*)::INTEGER AS total_packages
        FROM packages
        WHERE city_id IS NOT NULL
        GROUP BY city_id
      ) pkg ON c.id = pkg.city_id
      ORDER BY c.created_at ASC
    `);
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error fetching cities:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب قائمة المدن' });
  }
};

export const getCityById = async (req: Request, res: Response): Promise<void> => {
  try {
    const cityId = req.params.id;
    const result = await pool.query('SELECT * FROM cities WHERE id = $1', [cityId]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'المدينة غير موجوده' });
      return;
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error fetching city details:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل المدينة' });
  }
};

export const updateCity = async (req: Request, res: Response): Promise<void> => {
  try {
    const cityId = req.params.id;
    const { name, image_url, description } = req.body;

    const result = await pool.query(
      `UPDATE cities SET
         name = COALESCE($1, name),
         image_url = COALESCE($2, image_url),
         description = COALESCE($3, description)
       WHERE id = $4 RETURNING *`,
      [name, image_url, description, cityId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'المدينة غير موجودة' });
      return;
    }

    res.json({ success: true, message: 'تم تحديث بيانات المحافظة/المدينة بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating city:', error);
    res.status(500).json({ error: 'فشل تحديث المحافظة' });
  }
};

export const getCityCompanies = async (req: Request, res: Response): Promise<void> => {
  try {
    const cityId = req.params.id;
    const result = await pool.query('SELECT * FROM companies WHERE city_id = $1 ORDER BY created_at DESC', [cityId]);
    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error fetching city companies:', error);
    res.status(500).json({ error: 'فشل جلب شركات المحافظة' });
  }
};

export const createCityCompany = async (req: Request, res: Response): Promise<void> => {
  try {
    const cityId = req.params.id;
    const { name, description, logoUrl, bannerUrl, user_id } = req.body;

    if (!name) {
      res.status(400).json({ error: 'اسم الشركة مطلوب' });
      return;
    }

    const companyId = generate16CharId();
    const publicId = generateRandomToken('cmp');
    const result = await pool.query(
      `INSERT INTO companies (id, user_id, city_id, name, logo_url, banner_url, description, rating, reviews_count, verified, public_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0.0, 0, true, $8)
       RETURNING *`,
      [companyId, user_id || null, cityId, name, logoUrl || '', bannerUrl || '', description || 'شركة سياحية مرخصة', publicId]
    );

    // Update total_companies count in cities
    await pool.query('UPDATE cities SET total_companies = (SELECT COUNT(*) FROM companies WHERE city_id = $1) WHERE id = $1', [cityId]);

    res.status(201).json({
      success: true,
      message: 'تم إضافة الشركة للمحافظة بنجاح',
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error creating company for city:', error);
    res.status(500).json({ error: 'فشل إضافة الشركة للمحافظة' });
  }
};

export const linkCompanyToCity = async (req: Request, res: Response): Promise<void> => {
  try {
    const cityId = req.params.id;
    const { companyId } = req.body;

    if (!companyId) {
      res.status(400).json({ error: 'يرجى اختيار شركة مسجلة' });
      return;
    }

    const companyCheck = await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
    if (companyCheck.rows.length === 0) {
      res.status(404).json({ error: 'الشركة المحددة غير موجودة' });
      return;
    }

    // Link company to city
    await pool.query('UPDATE companies SET city_id = $1 WHERE id = $2', [cityId, companyId]);

    // Update total_companies count in cities
    await pool.query('UPDATE cities SET total_companies = (SELECT COUNT(*) FROM companies WHERE city_id = $1) WHERE id = $1', [cityId]);

    res.json({
      success: true,
      message: 'تم إضافة وربط الشركة المسجلة بالمحافظة بنجاح',
      data: companyCheck.rows[0],
    });
  } catch (error: any) {
    console.error('Error linking company to city:', error);
    res.status(500).json({ error: 'فشل ربط الشركة بالمحافظة' });
  }
};
