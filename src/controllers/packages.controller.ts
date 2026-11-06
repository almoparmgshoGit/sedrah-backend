import { Request, Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/security.middleware';
import { formatPackageId, formatCompanyId, parseIdOrToken } from '../utils/formatId';
import { enrichPackage, PACKAGE_EXTRA_COLUMNS } from '../utils/packageInfo';
import { companyReadySql } from '../utils/companyReadiness';
import { notifyCompanyTeam } from '../utils/companyAccess';

const STATUS_LABELS: Record<string, string> = { active: 'منشورة', paused: 'موقوفة', hidden: 'مخفية' };

export const getPackages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { cityId, companyId, minPrice, maxPrice } = req.query;
    let query = `
      SELECT p.*, c.name as company_name, c.logo_url as company_logo, ci.name as city_name, c.public_id as company_public_id,
             (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) as bookings_count, ${PACKAGE_EXTRA_COLUMNS}
      FROM packages p
      JOIN companies c ON p.company_id = c.id
      JOIN cities ci ON p.city_id = ci.id
      WHERE (p.status = 'active' OR p.status IS NULL) AND ${companyReadySql('c')}
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (cityId) {
      const parsedCity = parseIdOrToken(cityId);
      query += ` AND p.city_id = $${paramIndex++}`;
      params.push(parsedCity.value);
    }
    if (companyId) {
      const strComp = String(companyId).trim();
      query += ` AND (p.company_id = $${paramIndex} OR c.public_id = $${paramIndex} OR c.name = $${paramIndex})`;
      params.push(strComp);
      paramIndex++;
    }
    if (minPrice) {
      query += ` AND p.price >= $${paramIndex++}`;
      params.push(parseFloat(minPrice as string));
    }
    if (maxPrice) {
      query += ` AND p.price <= $${paramIndex++}`;
      params.push(parseFloat(maxPrice as string));
    }

    query += ' ORDER BY p.price ASC';

    const result = await pool.query(query, params);
    const formatted = result.rows.map(pkg => ({
      ...enrichPackage(pkg),
      numeric_id: pkg.id,
      id: formatPackageId(pkg.id, pkg.public_id),
      company_id: formatCompanyId(pkg.company_id, pkg.company_public_id),
      bookings_count: parseInt(pkg.bookings_count || '0', 10),
    }));

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('Error fetching packages:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب الباقات' });
  }
};

export const getPackageById = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const parsed = parseIdOrToken(rawId);
    let result;
    if (parsed.isToken) {
      result = await pool.query(
        `
        SELECT p.*, c.name as company_name, c.logo_url as company_logo, ci.name as city_name, c.public_id as company_public_id,
               (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) as bookings_count, ${PACKAGE_EXTRA_COLUMNS}
        FROM packages p
        JOIN companies c ON p.company_id = c.id
        JOIN cities ci ON p.city_id = ci.id
        WHERE p.public_id = $1
        `,
        [parsed.value]
      );
    } else {
      result = await pool.query(
        `
        SELECT p.*, c.name as company_name, c.logo_url as company_logo, ci.name as city_name, c.public_id as company_public_id,
               (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) as bookings_count, ${PACKAGE_EXTRA_COLUMNS}
        FROM packages p
        JOIN companies c ON p.company_id = c.id
        JOIN cities ci ON p.city_id = ci.id
        WHERE p.id = $1 OR p.public_id = $2
        `,
        [parsed.value, String(rawId)]
      );
    }

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }

    const pkg = enrichPackage(result.rows[0]);
    const numericId = pkg.id;
    pkg.id = formatPackageId(pkg.id, pkg.public_id);
    pkg.numeric_id = numericId;
    pkg.company_id = formatCompanyId(pkg.company_id, pkg.company_public_id);
    pkg.bookings_count = parseInt(pkg.bookings_count || '0', 10);

    res.json({
      success: true,
      data: pkg,
    });
  } catch (error: any) {
    console.error('Error fetching package details:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل الباقة' });
  }
};

export const updatePackageByAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const parsed = parseIdOrToken(rawId);
    const pkgId = parsed.value;

    const {
      title,
      duration,
      price,
      description,
      nights_count,
      departure_date,
      return_date,
      departure_airport,
      hotel_makkah,
      hotel_madinah,
      room_prices,
      max_adults,
      max_children,
      cancellation_policy,
      features,
      itinerary,
      status,
      image_url
    } = req.body;

    const result = await pool.query(
      `UPDATE packages SET
        title = COALESCE($1, title),
        duration = COALESCE($2, duration),
        price = COALESCE($3, price),
        description = COALESCE($4, description),
        nights_count = COALESCE($5, nights_count),
        departure_date = COALESCE($6, departure_date),
        return_date = COALESCE($7, return_date),
        departure_airport = COALESCE($8, departure_airport),
        hotel_makkah = COALESCE($9, hotel_makkah),
        hotel_madinah = COALESCE($10, hotel_madinah),
        room_prices = COALESCE($11, room_prices),
        max_adults = COALESCE($12, max_adults),
        max_children = COALESCE($13, max_children),
        cancellation_policy = COALESCE($14, cancellation_policy),
        features = COALESCE($15, features),
        itinerary = COALESCE($16, itinerary),
        status = COALESCE($17, status),
        image_url = COALESCE($18, image_url)
      WHERE id = $19 OR public_id = $20
      RETURNING *`,
      [
        title,
        duration,
        price ? parseFloat(price) : null,
        description,
        nights_count ? parseInt(String(nights_count), 10) : null,
        departure_date,
        return_date,
        departure_airport,
        hotel_makkah,
        hotel_madinah,
        typeof room_prices === 'object' ? JSON.stringify(room_prices) : room_prices,
        max_adults,
        max_children,
        cancellation_policy,
        typeof features === 'object' ? JSON.stringify(features) : features,
        typeof itinerary === 'object' ? JSON.stringify(itinerary) : itinerary,
        status,
        image_url,
        pkgId,
        String(rawId)
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }

    const updated = result.rows[0];
    await notifyCompanyTeam(updated.company_id, 'packages.view', {
      title: 'عدّلت الإدارة باقة',
      subtitle: `عدّلت إدارة سدرة بيانات الباقة "${updated.title}". راجع الباقة من قائمة الباقات.`,
      category: 'package',
      icon: 'create-outline',
      iconBg: '#EFF6FF',
      iconColor: '#2563EB',
      data: { type: 'admin_package_update', packageId: updated.id },
    });

    res.json({
      success: true,
      message: 'تم تحديث الباقة بنجاح',
      data: updated,
    });
  } catch (error: any) {
    console.error('Error updating package:', error);
    res.status(500).json({ error: 'فشل تحديث الباقة' });
  }
};

export const deletePackageByAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const parsed = parseIdOrToken(rawId);
    // Deleting cascades to the bookings, which would erase customers' reservations and payment records
    const existing = await pool.query(
      `SELECT p.id, p.title, p.company_id, (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id)::int AS bookings_count
       FROM packages p WHERE p.id = $1 OR p.public_id = $2`,
      [parsed.value, String(rawId)]
    );
    const pkg = existing.rows[0];
    if (!pkg) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    if (pkg.bookings_count > 0) {
      res.status(409).json({ error: `على هذه الباقة ${pkg.bookings_count} حجز، لا يمكن حذفها. استخدم الإخفاء بدلاً من الحذف` });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const result = await pool.query('DELETE FROM packages WHERE id = $1 RETURNING city_id', [pkg.id]);
    await notifyCompanyTeam(pkg.company_id, 'packages.view', {
      title: 'حذفت الإدارة باقة',
      subtitle: `حذفت إدارة سدرة الباقة "${pkg.title}"${reason ? `. السبب: ${reason}` : ''}`,
      category: 'package',
      icon: 'trash-outline',
      iconBg: '#FEF2F2',
      iconColor: '#DC2626',
      data: { type: 'admin_package_deleted' },
    });
    const cityId = result.rows[0].city_id;
    if (cityId) {
      await pool.query('UPDATE cities SET total_packages = (SELECT COUNT(*) FROM packages WHERE city_id = $1) WHERE id = $1', [cityId]);
    }
    res.json({ success: true, message: 'تم حذف الباقة بنجاح' });
  } catch (error: any) {
    console.error('Error deleting package:', error);
    res.status(500).json({ error: 'فشل حذف الباقة' });
  }
};

export const updatePackageStatusByAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const { status } = req.body; // 'active', 'paused', 'hidden'
    const parsed = parseIdOrToken(rawId);
    if (!['active', 'paused', 'hidden'].includes(status)) {
      res.status(400).json({ error: 'حالة غير معروفة' });
      return;
    }
    // The reason is shown to the company, so hiding a package always says why
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (status === 'hidden' && reason.length < 3) {
      res.status(400).json({ error: 'اكتب سبب الإخفاء ليظهر للشركة' });
      return;
    }

    const result = await pool.query(
      'UPDATE packages SET status = $1, admin_status_reason = $4 WHERE id = $2 OR public_id = $3 RETURNING *',
      [status, parsed.value, String(rawId), status === 'hidden' ? reason : null]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الباقة غير موجودة' });
      return;
    }
    const pkg = result.rows[0];
    await notifyCompanyTeam(pkg.company_id, 'packages.view', {
      title: status === 'hidden' ? 'أخفت الإدارة باقة' : `أصبحت الباقة ${STATUS_LABELS[status]}`,
      subtitle: status === 'hidden'
        ? `أخفت إدارة سدرة الباقة "${pkg.title}" عن العملاء. السبب: ${reason}`
        : `غيّرت إدارة سدرة حالة الباقة "${pkg.title}" إلى: ${STATUS_LABELS[status]}`,
      category: 'package',
      icon: status === 'hidden' ? 'eye-off-outline' : 'pricetag-outline',
      iconBg: status === 'hidden' ? '#FEF2F2' : '#ECFDF5',
      iconColor: status === 'hidden' ? '#DC2626' : '#059669',
      data: { type: 'admin_package_status', packageId: pkg.id, status },
    });

    res.json({ success: true, message: 'تم تغيير حالة الباقة بنجاح', data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating package status:', error);
    res.status(500).json({ error: 'فشل تغيير حالة الباقة' });
  }
};

// The package a customer-facing id or public token points to, while customers can see it.
// Visits and shares by the company's own owner and team are not counted.
const findTrackablePackage = async (req: AuthRequest): Promise<string | null> => {
  const rawId = String(req.params.id);
  const parsed = parseIdOrToken(rawId);
  const viewerId = String(req.user?.id || '');
  const result = await pool.query(
    `SELECT p.id FROM packages p JOIN companies c ON p.company_id = c.id
     WHERE (p.public_id = $1 OR p.id = $2)
       AND (p.status = 'active' OR p.status IS NULL)
       AND c.user_id IS DISTINCT FROM $3
       AND NOT EXISTS (SELECT 1 FROM company_members cm WHERE cm.company_id = c.id AND cm.user_id = $3)
     LIMIT 1`,
    [parsed.isToken ? parsed.value : rawId, parsed.isToken ? '' : parsed.value, viewerId]
  );
  return result.rows[0]?.id || null;
};

// Tracking never fails the customer's screen, so errors are logged and answered quietly
export const trackPackageView = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const viewerKey = String(req.user?.id || '').slice(0, 64);
    const packageId = viewerKey ? await findTrackablePackage(req) : null;
    if (packageId) {
      const inserted = await pool.query(
        'INSERT INTO package_views (package_id, viewer_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [packageId, viewerKey]
      );
      if (inserted.rowCount) await pool.query('UPDATE packages SET views_count = views_count + 1 WHERE id = $1', [packageId]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Package view tracking error:', error);
    res.json({ success: false });
  }
};

export const trackPackageShare = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const packageId = await findTrackablePackage(req);
    if (packageId) await pool.query('UPDATE packages SET shares_count = shares_count + 1 WHERE id = $1', [packageId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Package share tracking error:', error);
    res.json({ success: false });
  }
};
