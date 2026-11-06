import { Request, Response } from 'express';
import { pool } from '../config/db';
import { notifyCitySubscribers } from './cities.controller';
import { AuthRequest } from '../middlewares/security.middleware';
import { notifyCompanyTeam, resolveCompanyAccess } from '../utils/companyAccess';
import { logAudit } from '../utils/auditLogger';
import { enrichPackage, PACKAGE_EXTRA_COLUMNS } from '../utils/packageInfo';
import { companyReadySql } from '../utils/companyReadiness';
import { formatCompanyId, formatPackageId, formatUserId, parseIdOrToken, generateRandomToken, generate16CharId } from '../utils/formatId';

const findCompanyQuery = async (rawId: any) => {
  if (!rawId) return { rows: [] };
  const strId = String(rawId).trim();
  const compRes = await pool.query(
    'SELECT * FROM companies WHERE id = $1 OR public_id = $1 OR name = $1',
    [strId]
  );
  return compRes;
};

export const formatPublicCompany = (comp: any) => {
  if (!comp) return null;
  return {
    id: formatCompanyId(comp.id, comp.public_id),
    public_id: comp.public_id,
    name: comp.name,
    short_description: comp.short_description,
    description: comp.description || comp.short_description,
    logo_url: comp.logo_url,
    banner_url: comp.banner_url,
    city_id: comp.city_id,
    city_name: comp.city_name,
    address: comp.address,
    google_maps_url: comp.google_maps_url,
    phone: comp.phone,
    whatsapp: comp.whatsapp,
    social_links: comp.social_links,
    working_hours: comp.working_hours,
    holidays_notes: comp.holidays_notes,
    rating: comp.rating,
    reviews_count: comp.reviews_count,
    verification_type: comp.verification_type,
    total_bookings: comp.total_bookings,
    completed_bookings: comp.completed_bookings,
    in_progress_bookings: comp.in_progress_bookings,
  };
};

export const getCompanies = async (req: Request, res: Response): Promise<void> => {
  try {
    const { cityId, minRating, hasPackages, verification_type, search, sort } = req.query;
    let query = `
      SELECT c.*,
             ci.name as city_name,
             COALESCE(b_stats.total_bookings, 0) as total_bookings,
             COALESCE(b_stats.completed_bookings, 0) as completed_bookings,
             COALESCE(b_stats.in_progress_bookings, 0) as in_progress_bookings,
             COALESCE(b_stats.cancelled_bookings, 0) as cancelled_bookings,
             COALESCE(pe_stats.total_earnings, 0) as platform_earnings,
             CASE
               WHEN c.field_verified = TRUE THEN 'field'
               WHEN c.verified = TRUE THEN 'document'
               ELSE 'none'
             END as verification_type
      FROM companies c
      LEFT JOIN cities ci ON c.city_id = ci.id
      LEFT JOIN (
        SELECT p.company_id,
               COUNT(b.id) as total_bookings,
               COUNT(b.id) FILTER (WHERE b.status = 'confirmed' OR b.status = 'completed') as completed_bookings,
               COUNT(b.id) FILTER (WHERE b.status = 'pending' OR b.status = 'receipt_review' OR b.status = 'current') as in_progress_bookings,
               COUNT(b.id) FILTER (WHERE b.status = 'cancelled' OR b.status = 'rejected') as cancelled_bookings
        FROM bookings b
        JOIN packages p ON b.package_id = p.id
        GROUP BY p.company_id
      ) b_stats ON c.id = b_stats.company_id
      LEFT JOIN (
        SELECT company_id, SUM(commission_amount) as total_earnings
        FROM platform_earnings
        WHERE status = 'recorded'
        GROUP BY company_id
      ) pe_stats ON c.id = pe_stats.company_id
    `;

    // Only companies with a complete profile and a published package are listed
    let conditions: string[] = [companyReadySql('c')];
    let params: any[] = [];
    let paramIndex = 1;

    if (hasPackages === 'true' || hasPackages === '1') {
      conditions.push(`EXISTS (SELECT 1 FROM packages p WHERE p.company_id = c.id)`);
    }

    if (cityId) {
      const parsedCity = parseIdOrToken(cityId);
      conditions.push(`c.city_id = $${paramIndex}`);
      params.push(parsedCity.value);
      paramIndex++;
    }

    if (minRating) {
      conditions.push(`c.rating >= $${paramIndex}`);
      params.push(parseFloat(minRating as string));
      paramIndex++;
    }

    if (verification_type && verification_type !== 'all') {
      if (verification_type === 'field') {
        conditions.push(`c.field_verified = TRUE`);
      } else if (verification_type === 'document') {
        conditions.push(`c.verified = TRUE AND (c.field_verified IS NOT TRUE)`);
      } else if (verification_type === 'none') {
        conditions.push(`(c.verified IS NOT TRUE) AND (c.field_verified IS NOT TRUE)`);
      }
    }

    if (search) {
      conditions.push(`(c.name ILIKE $${paramIndex} OR c.short_description ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    if (sort === 'rating_desc') {
      query += ' ORDER BY c.rating DESC NULLS LAST';
    } else if (sort === 'earnings_desc') {
      query += ' ORDER BY platform_earnings DESC';
    } else if (sort === 'bookings_desc') {
      query += ' ORDER BY total_bookings DESC';
    } else {
      query += ' ORDER BY c.created_at DESC';
    }

    const result = await pool.query(query, params);
    const formatted = result.rows.map(comp => formatPublicCompany({
      ...comp,
      platform_earnings: parseFloat(comp.platform_earnings || 0),
    }));

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب قائمة الشركات' });
  }
};

export const getCompanyById = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const result = await findCompanyQuery(rawId);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const comp = result.rows[0];
    const formatted = formatPublicCompany(comp);

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('Error fetching company details:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل الشركة' });
  }
};

export const createCompanyFull = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      name,
      short_description,
      long_description,
      owner_email,
      phone,
      whatsapp,
      landline_phone,
      website_url,
      social_links,
      city_id,
      address,
      google_maps_url,
      logo_url,
      banner_url,
      working_hours,
      holidays_notes,
      commercial_register_url,
      tax_id_url,
      manager_id_url,
      manager_id_back_url,
      field_verified,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'اسم الشركة مطلوب' });
      return;
    }

    // Resolve owner user ID or pending email
    let userId: number | null = null;
    let pendingOwnerEmail: string | null = null;

    if (owner_email) {
      const userCheck = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [owner_email.trim()]);
      if (userCheck.rows.length > 0) {
        userId = userCheck.rows[0].id;
      } else {
        pendingOwnerEmail = owner_email.trim();
      }
    }

    const companyId = generate16CharId();
    const publicId = generateRandomToken('cmp');
    const isVerified = field_verified === true || field_verified === 'true' || field_verified === '1';

    const result = await pool.query(
      `INSERT INTO companies (
        id, user_id, pending_owner_email, city_id, name, short_description, description,
        phone, whatsapp, landline_phone, website_url, social_links, address, google_maps_url,
        logo_url, banner_url, working_hours, holidays_notes, commercial_register_url,
        tax_id_url, manager_id_url, manager_id_back_url, field_verified, verified, rating, reviews_count, public_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 0.0, 0, $25)
      RETURNING *`,
      [
        companyId,
        userId,
        pendingOwnerEmail,
        city_id || null,
        name,
        short_description || '',
        long_description || '',
        phone || '',
        whatsapp || '',
        landline_phone || '',
        website_url || '',
        typeof social_links === 'object' ? JSON.stringify(social_links) : (social_links || ''),
        address || '',
        google_maps_url || '',
        logo_url || '',
        banner_url || '',
        typeof working_hours === 'object' ? JSON.stringify(working_hours) : (working_hours || ''),
        holidays_notes || '',
        commercial_register_url || '',
        tax_id_url || '',
        manager_id_url || '',
        manager_id_back_url || '',
        isVerified,
        isVerified,
        publicId
      ]
    );

    const comp = result.rows[0];

    if (city_id) {
      await pool.query('UPDATE cities SET total_companies = (SELECT COUNT(*) FROM companies WHERE city_id = $1) WHERE id = $1', [city_id]);
      notifyCitySubscribers(city_id, name).catch((err) => console.error('City notification error:', err));
    }

    res.status(201).json({
      success: true,
      message: 'تم إضافة وإنشاء الشركة بنجاح',
      data: comp,
    });
  } catch (error: any) {
    console.error('Error in createCompanyFull:', error);
    res.status(500).json({ error: 'فشل إنشاء الشركة' });
  }
};

export const getCompanyPackages = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const compRes = await findCompanyQuery(rawId);

    if (compRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const companyId = compRes.rows[0].id;
    const result = await pool.query(`
      SELECT p.*, (SELECT COUNT(*) FROM bookings b WHERE b.package_id = p.id) as bookings_count, ${PACKAGE_EXTRA_COLUMNS}
      FROM packages p
      JOIN companies c ON p.company_id = c.id
      WHERE p.company_id = $1 AND (p.status = 'active' OR p.status IS NULL) AND ${companyReadySql('c')}
      ORDER BY p.created_at ASC
    `, [companyId]);

    const formatted = result.rows.map(pkg => ({
      ...enrichPackage(pkg),
      id: formatPackageId(pkg.id, pkg.public_id),
      company_id: formatCompanyId(companyId, compRes.rows[0].public_id),
      bookings_count: parseInt(pkg.bookings_count || '0', 10),
    }));

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('Error fetching company packages:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب باقات الشركة' });
  }
};

export const getCompanyReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const compRes = await findCompanyQuery(rawId);

    if (compRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const companyId = compRes.rows[0].id;
    const result = await pool.query(`
      SELECT r.*, u.name as user_name, u.public_id as user_public_id
      FROM reviews r
      JOIN users u ON r.user_id = u.id
      WHERE r.company_id = $1 AND COALESCE(r.hidden, FALSE) = FALSE
      ORDER BY r.created_at DESC
    `, [companyId]);

    const formatted = result.rows.map(rev => ({
      id: rev.id,
      rating: rev.rating,
      comment: rev.comment,
      created_at: rev.created_at,
      company_reply: rev.company_reply || null,
      company_reply_at: rev.company_reply_at || null,
      company_id: formatCompanyId(companyId, compRes.rows[0].public_id),
      user_name: 'عميل سدرة',
    }));

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('Error fetching company reviews:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تقييمات الشركة' });
  }
};

export const addCompanyReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const compRes = await findCompanyQuery(rawId);

    if (compRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const companyId = compRes.rows[0].id;
    const userId = req.user?.id;
    const rating = Number(req.body?.rating);
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';

    if (!userId) {
      res.status(401).json({ error: 'يجب تسجيل الدخول لإضافة تقييم' });
      return;
    }

    // An out-of-range value would distort the company's average rating for everyone
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      res.status(400).json({ error: 'التقييم يجب أن يكون من 1 إلى 5 نجوم' });
      return;
    }
    if (comment.length > 1000) {
      res.status(400).json({ error: 'التعليق طويل جداً (الحد الأقصى 1000 حرف)' });
      return;
    }

    const result = await pool.query(`
      SELECT * FROM reviews WHERE company_id = $1 AND user_id = $2
    `, [companyId, userId]);

    let revRes;
    if (result.rows.length > 0) {
      revRes = await pool.query(`
        UPDATE reviews SET rating = $1, comment = $2 WHERE company_id = $3 AND user_id = $4 RETURNING *
      `, [rating, comment, companyId, userId]);
    } else {
      revRes = await pool.query(`
        INSERT INTO reviews (id, company_id, user_id, rating, comment)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [generate16CharId(), companyId, userId, rating, comment]);
    }

    await pool.query(`
      UPDATE companies
      SET reviews_count = (SELECT COUNT(*) FROM reviews WHERE company_id = $1 AND COALESCE(hidden, FALSE) = FALSE),
          rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE company_id = $1 AND COALESCE(hidden, FALSE) = FALSE), 0.0)
      WHERE id = $1
    `, [companyId]);

    const rev = revRes.rows[0];
    const userRes = await pool.query('SELECT public_id FROM users WHERE id = $1', [userId]);
    const userPubId = userRes.rows[0]?.public_id;

    rev.company_id = formatCompanyId(companyId, compRes.rows[0].public_id);
    rev.user_id = formatUserId(userId, userPubId);

    res.status(201).json({
      success: true,
      message: 'تم إضافة التقييم بنجاح',
      data: rev,
    });
  } catch (error: any) {
    console.error('Error adding review:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء إضافة التقييم' });
  }
};

export const getCompanyAdminDetails = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const compRes = await findCompanyQuery(rawId);

    if (compRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const company = compRes.rows[0];
    const companyId = company.id;

    // 1. Packages
    const packagesRes = await pool.query('SELECT * FROM packages WHERE company_id = $1 ORDER BY created_at DESC', [companyId]);

    // 2. Reviews
    const reviewsRes = await pool.query(`
      SELECT r.*, u.name as user_name, u.email as user_email
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.company_id = $1
      ORDER BY r.created_at DESC
    `, [companyId]);

    // 3. Bookings
    const bookingsRes = await pool.query(`
      SELECT b.*, p.title as package_title, p.price as package_price, u.name as user_name, u.email as user_email, u.phone as user_phone
      FROM bookings b
      JOIN packages p ON b.package_id = p.id
      LEFT JOIN users u ON b.user_id = u.id
      WHERE p.company_id = $1
      ORDER BY b.created_at DESC
    `, [companyId]);

    // 4. Trip Stages / Trips
    const tripsRes = await pool.query(`
      SELECT ts.*, b.booking_reference, p.title as package_title, u.name as user_name
      FROM trip_stages ts
      JOIN bookings b ON ts.booking_id = b.id
      JOIN packages p ON b.package_id = p.id
      LEFT JOIN users u ON b.user_id = u.id
      WHERE p.company_id = $1
      ORDER BY ts.created_at DESC
    `, [companyId]);

    res.json({
      success: true,
      data: {
        company,
        packages: packagesRes.rows,
        reviews: reviewsRes.rows,
        bookings: bookingsRes.rows,
        trips: tripsRes.rows,
      },
    });
  } catch (error: any) {
    console.error('Error fetching company admin details:', error);
    res.status(500).json({ error: 'فشل جلب بيانات وتفاصيل الشركة' });
  }
};

export const createCompanyPackage = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const compRes = await findCompanyQuery(rawId);

    if (compRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const companyId = compRes.rows[0].id;
    const {
      title,
      duration,
      price,
      image_url,
      description,
      features,
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
      itinerary,
      city_id
    } = req.body;

    if (!title || !duration) {
      res.status(400).json({ error: 'عنوان الباقة والمدة مطلوبين' });
      return;
    }

    let targetCityId = city_id || compRes.rows[0].city_id;
    if (!targetCityId) {
      const firstCityRes = await pool.query('SELECT id FROM cities ORDER BY created_at ASC LIMIT 1');
      if (firstCityRes.rows.length > 0) {
        targetCityId = firstCityRes.rows[0].id;
      }
    }
    const publicId = generateRandomToken('pkg');
    const packageId = generate16CharId();

    const result = await pool.query(
      `INSERT INTO packages (
        id, company_id, city_id, title, duration, price, rating, image_url, description,
        features, nights_count, departure_date, return_date, departure_airport,
        hotel_makkah, hotel_madinah, room_prices, max_adults, max_children, cancellation_policy, itinerary, public_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 0.0, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *`,
      [
        packageId,
        companyId,
        targetCityId,
        title,
        duration,
        price ? parseFloat(price) : null,
        image_url || '',
        description || '',
        typeof features === 'object' ? JSON.stringify(features) : (features || ''),
        nights_count ? parseInt(String(nights_count), 10) : null,
        departure_date || '',
        return_date || '',
        departure_airport || '',
        typeof hotel_makkah === 'object' ? JSON.stringify(hotel_makkah) : (hotel_makkah || ''),
        typeof hotel_madinah === 'object' ? JSON.stringify(hotel_madinah) : (hotel_madinah || ''),
        typeof room_prices === 'object' ? JSON.stringify(room_prices) : (room_prices || ''),
        max_adults || 'unlimited',
        max_children || 'unlimited',
        cancellation_policy || '',
        typeof itinerary === 'object' ? JSON.stringify(itinerary) : (itinerary || ''),
        publicId
      ]
    );

    // Update total_packages in cities
    await pool.query('UPDATE cities SET total_packages = (SELECT COUNT(*) FROM packages WHERE city_id = $1) WHERE id = $1', [targetCityId]);

    await notifyCompanyTeam(result.rows[0].company_id, 'packages.view', {
      title: 'أضافت الإدارة باقة لشركتكم',
      subtitle: `أضافت إدارة سدرة الباقة "${result.rows[0].title}" إلى باقات شركتكم.`,
      category: 'package',
      icon: 'add-circle-outline',
      iconBg: '#ECFDF5',
      iconColor: '#059669',
      data: { type: 'admin_package_created', packageId: result.rows[0].id },
    });

    res.status(201).json({
      success: true,
      message: 'تم إضافة الباقة للشركة بنجاح',
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error creating company package:', error);
    res.status(500).json({ error: 'فشل إضافة الباقة للشركة' });
  }
};

export const updateCompany = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawId = req.params.id;
    const compRes = await findCompanyQuery(rawId);

    if (compRes.rows.length === 0) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }

    const companyId = compRes.rows[0].id;

    const {
      name,
      short_description,
      description,
      phone,
      whatsapp,
      landline_phone,
      website_url,
      social_links,
      city_id,
      address,
      google_maps_url,
      logo_url,
      banner_url,
      working_hours,
      working_days,
      working_hours_start,
      working_hours_end,
      max_daily_capacity,
      slot_duration_minutes,
      holidays_notes,
      commercial_register_url,
      tax_id_url,
      manager_id_url,
      manager_id_back_url,
      field_verified,
      owner_email
    } = req.body;

    let userId = undefined;
    if (owner_email !== undefined) {
      if (owner_email) {
        const userCheck = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [owner_email.trim()]);
        userId = userCheck.rows.length > 0 ? userCheck.rows[0].id : null;
      } else {
        userId = null;
      }
    }

    const isVerified = field_verified !== undefined ? (field_verified === true || field_verified === 'true' || field_verified === '1') : undefined;

    const workingDaysStr = working_days ? (Array.isArray(working_days) ? JSON.stringify(working_days) : String(working_days)) : null;

    const paramList: any[] = [
      name,
      short_description,
      description,
      phone,
      whatsapp,
      landline_phone,
      website_url,
      typeof social_links === 'object' ? JSON.stringify(social_links) : social_links,
      city_id ? parseInt(String(city_id), 10) : null,
      address,
      google_maps_url,
      logo_url,
      banner_url,
      typeof working_hours === 'object' ? JSON.stringify(working_hours) : working_hours,
      holidays_notes,
      commercial_register_url,
      tax_id_url,
      manager_id_url,
      manager_id_back_url,
      isVerified,
      isVerified,
      workingDaysStr,
      working_hours_start,
      working_hours_end,
      max_daily_capacity ? parseInt(String(max_daily_capacity), 10) : null,
      slot_duration_minutes ? parseInt(String(slot_duration_minutes), 10) : null,
    ];

    let userIdSql = '';
    if (userId !== undefined) {
      paramList.push(userId);
      userIdSql = `, user_id = $${paramList.length}`;
    }

    paramList.push(companyId);
    const companyIdParamIndex = paramList.length;

    const result = await pool.query(
      `UPDATE companies SET
        name = COALESCE(NULLIF($1, ''), name),
        short_description = COALESCE(NULLIF($2, ''), short_description),
        description = COALESCE(NULLIF($3, ''), description),
        phone = COALESCE(NULLIF($4, ''), phone),
        whatsapp = COALESCE(NULLIF($5, ''), whatsapp),
        landline_phone = COALESCE(NULLIF($6, ''), landline_phone),
        website_url = COALESCE(NULLIF($7, ''), website_url),
        social_links = COALESCE($8, social_links),
        city_id = COALESCE($9, city_id),
        address = COALESCE(NULLIF($10, ''), address),
        google_maps_url = COALESCE(NULLIF($11, ''), google_maps_url),
        logo_url = COALESCE(NULLIF($12, ''), logo_url),
        banner_url = COALESCE(NULLIF($13, ''), banner_url),
        working_hours = COALESCE($14, working_hours),
        holidays_notes = COALESCE(NULLIF($15, ''), holidays_notes),
        commercial_register_url = COALESCE(NULLIF($16, ''), commercial_register_url),
        tax_id_url = COALESCE(NULLIF($17, ''), tax_id_url),
        manager_id_url = COALESCE(NULLIF($18, ''), manager_id_url),
        manager_id_back_url = COALESCE(NULLIF($19, ''), manager_id_back_url),
        field_verified = COALESCE($20, field_verified),
        verified = COALESCE($21, verified),
        working_days = COALESCE($22, working_days),
        working_hours_start = COALESCE(NULLIF($23, ''), working_hours_start),
        working_hours_end = COALESCE(NULLIF($24, ''), working_hours_end),
        max_daily_capacity = COALESCE($25, max_daily_capacity),
        slot_duration_minutes = COALESCE($26, slot_duration_minutes)
        ${userIdSql}
      WHERE id = $${companyIdParamIndex}
      RETURNING *`,
      paramList
    );

    const updatedComp = result.rows[0];
    const before = compRes.rows[0];

    // The company team is told what the platform changed in its profile
    const FIELD_LABELS: Record<string, string> = {
      name: 'الاسم', short_description: 'الوصف القصير', description: 'الوصف', phone: 'الجوال', whatsapp: 'الواتساب',
      landline_phone: 'الهاتف الأرضي', website_url: 'الموقع الإلكتروني', social_links: 'حسابات التواصل', city_id: 'المحافظة',
      address: 'العنوان', google_maps_url: 'الخريطة', logo_url: 'الشعار', banner_url: 'الغلاف', working_hours: 'أوقات العمل',
      holidays_notes: 'الإجازات', commercial_register_url: 'السجل التجاري', tax_id_url: 'البطاقة الضريبية',
      manager_id_url: 'بطاقة المدير', manager_id_back_url: 'بطاقة المدير (الخلفية)',
      max_daily_capacity: 'عدد الزيارات اليومية', slot_duration_minutes: 'مدة الزيارة',
    };
    const changed = Object.keys(FIELD_LABELS).filter((key) => String(before[key] ?? '') !== String(updatedComp[key] ?? ''));
    const verificationChanged = Boolean(before.field_verified) !== Boolean(updatedComp.field_verified);
    if (changed.length > 0 || verificationChanged) {
      const parts = [
        ...(verificationChanged ? [updatedComp.field_verified ? 'تم توثيق شركتكم ميدانياً' : 'أُلغي التوثيق الميداني لشركتكم'] : []),
        ...(changed.length > 0 ? [`عُدّلت: ${changed.map((key) => FIELD_LABELS[key]).join('، ')}`] : []),
      ];
      await notifyCompanyTeam(updatedComp.id, 'company.profile', {
        title: verificationChanged && updatedComp.field_verified ? 'تم توثيق شركتكم' : 'عدّلت الإدارة بيانات شركتكم',
        subtitle: parts.join('. '),
        category: 'company',
        icon: verificationChanged && updatedComp.field_verified ? 'shield-checkmark-outline' : 'business-outline',
        iconBg: '#ECFDF5',
        iconColor: '#059669',
        data: { type: 'admin_company_update', fields: changed },
      });
    }

    updatedComp.id = formatCompanyId(updatedComp.id, updatedComp.public_id);

    res.json({
      success: true,
      message: 'تم تحديث بيانات الشركة بنجاح',
      data: updatedComp,
    });
  } catch (error: any) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: 'فشل تحديث بيانات الشركة' });
  }
};

export const getMyCompanyProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
      return;
    }

    const userId = req.user.id;
    const userEmail = req.user.email;

    // Owners and team members alike; a pending invitation for this email is claimed here
    const access = await resolveCompanyAccess(String(userId), userEmail);
    if (access && 'suspended' in access) {
      res.status(403).json({ error: `تم إيقاف حسابك في فريق ${access.companyName}، تواصل مع مسؤول الشركة`, code: 'MEMBER_SUSPENDED' });
      return;
    }
    if (!access) {
      res.status(404).json({ error: 'لم يتم العثور على شركة مرتبطة بحسابك' });
      return;
    }

    const result = await pool.query(
      `SELECT c.*, ci.name as city_name FROM companies c LEFT JOIN cities ci ON c.city_id = ci.id WHERE c.id = $1`,
      [access.company.id]
    );
    const comp = result.rows[0];
    const formatted = {
      ...comp,
      id: formatCompanyId(comp.id, comp.public_id),
      access: {
        is_owner: access.isOwner,
        role_name: access.roleName,
        job_title: access.jobTitle,
        permissions: access.permissions,
      },
    };

    res.json({
      success: true,
      data: formatted,
    });
  } catch (error: any) {
    console.error('Error fetching my company profile:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب ملف الشركة' });
  }
};


const COMPANY_DOCUMENT_LABELS: Record<string, string> = {
  commercial_register_url: 'السجل التجاري',
  tax_id_url: 'البطاقة الضريبية',
  manager_id_url: 'بطاقة المدير (الوجه الأمامي)',
  manager_id_back_url: 'بطاقة المدير (الوجه الخلفي)',
};

// Reviews one official company document; a rejection tells the company what to fix and re-upload
export const reviewCompanyDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const field = String(req.params.field);
    if (!COMPANY_DOCUMENT_LABELS[field]) {
      res.status(400).json({ error: 'مستند غير معروف' });
      return;
    }
    const status = String(req.body?.status || '');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!['approved', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'اختر قبول المستند أو رفضه' });
      return;
    }
    if (status === 'rejected' && reason.length < 3) {
      res.status(400).json({ error: 'اكتب سبب رفض المستند ليظهر للشركة' });
      return;
    }

    const compRes = await findCompanyQuery(String(req.params.id));
    const company = compRes.rows[0];
    if (!company) {
      res.status(404).json({ error: 'الشركة غير موجودة' });
      return;
    }
    if (!company[field]) {
      res.status(400).json({ error: 'لم ترفع الشركة هذا المستند بعد' });
      return;
    }

    let review: Record<string, any> = {};
    try {
      review = company.documents_review ? JSON.parse(company.documents_review) : {};
    } catch {
      review = {};
    }
    review[field] = {
      status,
      reason: status === 'rejected' ? reason : null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: req.user?.email || 'الإدارة',
    };
    await pool.query('UPDATE companies SET documents_review = $1 WHERE id = $2', [JSON.stringify(review), company.id]);

    const label = COMPANY_DOCUMENT_LABELS[field];
    await notifyCompanyTeam(company.id, 'company.documents', {
      title: status === 'approved' ? `تم قبول ${label}` : `مطلوب إعادة رفع ${label}`,
      subtitle: status === 'approved'
        ? `راجعت إدارة سدرة ${label} وقبلته.`
        : `رفضت إدارة سدرة ${label}. السبب: ${reason}. ارفع نسخة جديدة من قسم المستندات الرسمية.`,
      category: 'company',
      icon: status === 'approved' ? 'checkmark-circle-outline' : 'alert-circle-outline',
      iconBg: status === 'approved' ? '#ECFDF5' : '#FEF2F2',
      iconColor: status === 'approved' ? '#059669' : '#DC2626',
      data: { type: 'company_document_review', field, status },
    });
    await logAudit(
      req.user?.email || 'admin',
      status === 'approved' ? 'قبول مستند شركة' : 'رفض مستند شركة',
      `${label} لشركة (${company.name})${reason ? ` · السبب: ${reason}` : ''}`,
      req.ip,
      req.user?.email
    );
    res.json({ success: true, message: status === 'approved' ? 'تم قبول المستند' : 'تم رفض المستند وإبلاغ الشركة', data: review });
  } catch (error: any) {
    console.error('Review company document error:', error);
    res.status(500).json({ error: 'تعذر حفظ مراجعة المستند' });
  }
};
