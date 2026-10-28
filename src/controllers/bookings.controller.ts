import { Request, Response } from 'express';
import { pool } from '../config/db';
import { parseIdOrToken, generate16CharId } from '../utils/formatId';
import { suggestAppointmentForBooking } from '../utils/appointmentEngine';
import { createAndSendNotification } from '../utils/notificationHelper';

export const createBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const { packageId, travelersCount, totalPrice, bookingMethod, roomType, childrenCount, notes } = req.body;
    if (!packageId || !totalPrice) {
      res.status(400).json({ error: 'بيانات الحجز غير مكتملة' });
      return;
    }

    const parsedPkg = parseIdOrToken(packageId);
    let resolvedPackageId = parsedPkg.value;
    if (parsedPkg.isToken) {
      const pkgRes = await pool.query('SELECT id FROM packages WHERE public_id = $1 OR id = $1', [parsedPkg.value]);
      resolvedPackageId = pkgRes.rows.length > 0 ? pkgRes.rows[0].id : parsedPkg.value;
    }

    const pkgRes = await pool.query('SELECT company_id FROM packages WHERE id = $1', [resolvedPackageId]);
    const companyId = pkgRes.rows.length > 0 ? pkgRes.rows[0].company_id : 1;

    // Suggest appointment for booking
    let suggestedAppt = await suggestAppointmentForBooking(companyId);
    if (!suggestedAppt) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      suggestedAppt = {
        date: tomorrow.toISOString().split('T')[0],
        time: '10:00 ص'
      };
    }

    const bookingRef = 'SDR-' + Math.floor(100000 + Math.random() * 900000);

    // Fetch commission settings
    const settingsRes = await pool.query('SELECT key, value FROM settings WHERE key IN (\'commission_system_enabled\', \'commission_method\', \'commission_percentage\', \'adult_commission_rate\', \'child_commission_rate\')');
    const settingsMap: Record<string, string> = {};
    for (const row of settingsRes.rows) {
      settingsMap[row.key] = row.value;
    }

    let commissionAmount = 0;
    const commissionEnabled = settingsMap['commission_system_enabled'] !== 'false';
    const commissionMethod = settingsMap['commission_method'] || 'percentage_total';
    let rateUsedDesc = '';

    if (commissionEnabled) {
      const total = Number(totalPrice) || 0;
      const countAdults = Number(travelersCount) || 1;
      const countChildren = Number(childrenCount) || 0;

      if (commissionMethod === 'per_individual') {
        const adultRate = Number(settingsMap['adult_commission_rate'] || 5);
        const childRate = Number(settingsMap['child_commission_rate'] || 2);
        const avgPerPerson = countAdults + countChildren > 0 ? total / (countAdults + countChildren) : total;
        commissionAmount = (countAdults * avgPerPerson * (adultRate / 100)) + (countChildren * avgPerPerson * (childRate / 100));
        rateUsedDesc = `أفراد: بالغين ${adultRate}%، أطفال ${childRate}%`;
      } else {
        const pct = Number(settingsMap['commission_percentage'] || 5);
        commissionAmount = total * (pct / 100);
        rateUsedDesc = `إجمالي الحجز: ${pct}%`;
      }
    }

    const newBookingId = generate16CharId();
    const result = await pool.query(
      `INSERT INTO bookings (id, user_id, package_id, booking_reference, status, booking_method, room_type, travelers_count, children_count, total_price, notes, appointment_date, appointment_time, appointment_status, commission_amount, commission_method_used, commission_rate_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        newBookingId,
        userId,
        resolvedPackageId,
        bookingRef,
        'new',
        bookingMethod || 'sidra',
        roomType || 'quad',
        travelersCount || 2,
        childrenCount || 0,
        totalPrice,
        notes || '',
        suggestedAppt ? suggestedAppt.date : null,
        suggestedAppt ? suggestedAppt.time : null,
        suggestedAppt ? 'suggested' : 'none',
        commissionAmount,
        commissionMethod,
        rateUsedDesc
      ]
    );

    const bookingId = result.rows[0].id;
    const currentDate = new Date().toLocaleDateString('ar-EG', { month: 'long', day: 'numeric', year: 'numeric' });

    const apptSubtitle = suggestedAppt
      ? `الموعد المقترح للزيارة: ${suggestedAppt.date} الساعة ${suggestedAppt.time}`
      : 'يرجى مراجعة الشركة لتأكيد موعد الزيارة';

    // Seed default trip tracking stages
    const defaultStages = [
      { order: 1, title: 'انتظار زيارة المستخدم للشركة', subtitle: apptSubtitle, status: 'current', date: currentDate },
      { order: 2, title: 'بانتظار مراجعة إيصال الدفع', subtitle: 'يتم رفع الإيصال بعد تسجيل إتمام زيارة الشركة', status: 'pending', date: 'قريباً' },
      { order: 3, title: 'تأكيد الحجز النهائي', subtitle: 'اعتماد الإيصال وتأكيد الحجز بنجاح', status: 'pending', date: 'قريباً' },
      { order: 4, title: 'جارٍ تجهيز التأشيرات', subtitle: 'تصدُر بعد تأكيد الحجز واعتماد الإيصال من الشركة', status: 'pending', date: 'قريباً' },
      { order: 5, title: 'تم إصدار التأشيرات', subtitle: 'المستندات متاحة للتحميل في قسم مستندات رحلتي', status: 'pending', date: 'قريباً' },
      { order: 6, title: 'تذاكر الطيران والسكن', subtitle: 'حجز الفنادق وتذاكر الطيران الرسمية', status: 'pending', date: 'قريباً' },
      { order: 7, title: 'جاهزية الرحلة والتوجه للمطار', subtitle: 'تعليمات السفر والتجمع', status: 'pending', date: 'قريباً' },
      { order: 8, title: 'اكتملت الرحلة بسلام', subtitle: 'عمرة مقبولة وذنب مغفور', status: 'pending', date: 'العودة' },
    ];

    for (const st of defaultStages) {
      await pool.query(
        `INSERT INTO trip_stages (id, booking_id, stage_order, title, subtitle, status, stage_date) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [generate16CharId(), bookingId, st.order, st.title, st.subtitle, st.status, st.date]
      );
    }

    // Create real notification and send push for booking creation
    await createAndSendNotification({
      userId,
      title: 'تم إنشاء طلب حجز جديد',
      subtitle: `تم استلام طلب حجزك برقم ${bookingRef} بنجاح. يرجى متابعة تفاصيل الحجز ورفع الإيصال.`,
      category: 'الحجز',
      icon: 'checkmark-circle-outline',
      iconBg: 'bg-emerald-50 border-emerald-100',
      iconColor: '#059669',
      data: { type: 'booking_created', bookingRef, bookingId },
    });

    res.status(201).json({
      success: true,
      message: 'تم إنشاء الحجز بنجاح',
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء الحجز' });
  }
};

export const getUserBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    // Auto-fix bookings that were incorrectly marked completed without receipt approval
    await pool.query(`
      UPDATE bookings
      SET status = 'receipt_review'
      WHERE receipt_approved = FALSE AND (status = 'completed' OR status = 'confirmed')
    `);

    // Auto-update completed bookings ONLY when confirmed and all stages are completed
    await pool.query(`
      UPDATE bookings b
      SET status = 'completed'
      WHERE b.status = 'confirmed' AND b.receipt_approved = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id AND ts.status != 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM trip_stages ts WHERE ts.booking_id = b.id
      )
    `);

    const result = await pool.query(
      `
      SELECT b.*, p.title as package_title, p.duration, p.image_url, c.name as company_name, c.logo_url as company_logo
      FROM bookings b
      JOIN packages p ON b.package_id = p.id
      JOIN companies c ON p.company_id = c.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
      `,
      [String(userId)]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error fetching user bookings:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب الحجوزات' });
  }
};

export const getBookingById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    const bookingId = req.params.id;

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const result = await pool.query(
      `
      SELECT b.*, p.title as package_title, p.duration, p.image_url, p.price, c.name as company_name, c.logo_url as company_logo
      FROM bookings b
      JOIN packages p ON b.package_id = p.id
      JOIN companies c ON p.company_id = c.id
      WHERE b.id = $1 AND b.user_id = $2
      `,
      [bookingId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الحجز غير موجود أو ليس لديك صلاحية لعرضه' });
      return;
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error fetching booking details:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل الحجز' });
  }
};

export const updateBookingReceipt = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    const bookingId = req.params.id;
    const { receiptUrl, receipt_url } = req.body || {};
    const finalReceiptUrl = receiptUrl || receipt_url || null;

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const result = await pool.query(
      `UPDATE bookings
       SET status = 'receipt_review',
           receipt_url = COALESCE(NULLIF($1, ''), receipt_url),
           receipt_approved = FALSE,
           receipt_status = 'pending',
           rejection_reason = NULL
       WHERE (id::text = $2 OR booking_reference = $2) AND user_id = $3
       RETURNING *`,
      [finalReceiptUrl, bookingId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الحجز غير موجود' });
      return;
    }

    const booking = result.rows[0];

    try {
      await pool.query(
        `UPDATE trip_stages SET status = 'completed', document_url = COALESCE(NULLIF($1, ''), document_url) WHERE booking_id = $2 AND stage_order = 2`,
        [finalReceiptUrl, booking.id]
      );
      await pool.query(
        `UPDATE trip_stages SET status = 'current' WHERE booking_id = $1 AND stage_order = 3`,
        [booking.id]
      );
    } catch (stageErr) {
      console.error('Error updating stages on receipt:', stageErr);
    }

    await createAndSendNotification({
      userId,
      title: 'تم إرسال إيصال الدفع',
      subtitle: `تم رفع إيصال الدفع لحجز ${booking.booking_reference} بنجاح وهو الآن قيد مراجعة واعتماد الإدارة.`,
      category: 'الحجز',
      icon: 'document-text-outline',
      iconBg: 'bg-blue-50 border-blue-100',
      iconColor: '#3B82F6',
      data: { type: 'receipt_uploaded', bookingRef: booking.booking_reference, bookingId: booking.id },
    });

    res.json({
      success: true,
      message: 'تم رفع إيصال الدفع بنجاح وأصبح قيد مراجعة واعتماد الإدارة',
      data: booking,
    });
  } catch (error: any) {
    console.error('Error updating receipt:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء رفع الإيصال' });
  }
};

export const linkBookingByReference = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    const rawRef = req.body.bookingReference || req.body.referenceCode;
    const bookingReference = rawRef ? String(rawRef).trim() : '';

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    if (!bookingReference) {
      res.status(400).json({ error: 'يرجى إدخال رقم كود الحجز' });
      return;
    }

    const bookingResult = await pool.query(
      'SELECT * FROM bookings WHERE booking_reference = $1',
      [bookingReference.trim()]
    );

    if (bookingResult.rows.length === 0) {
      res.status(404).json({ error: 'رقم كود الحجز غير موجود في النظام' });
      return;
    }

    const booking = bookingResult.rows[0];

    const updateResult = await pool.query(
      'UPDATE bookings SET user_id = $1 WHERE id = $2 RETURNING *',
      [userId, booking.id]
    );

    await createAndSendNotification({
      userId,
      title: 'تم ربط الحجز بنجاح',
      subtitle: `تم ربط الحجز ${booking.booking_reference} بنجاح وإضافته لقائمة رحلاتك.`,
      category: 'الحجز',
      icon: 'link-outline',
      iconBg: 'bg-amber-50 border-amber-200',
      iconColor: '#C8A96A',
      data: { type: 'booking_linked', bookingRef: booking.booking_reference, bookingId: booking.id },
    });

    res.json({
      success: true,
      message: 'تم ربط الحجز بنجاح',
      data: updateResult.rows[0],
    });
  } catch (error: any) {
    console.error('Error linking booking:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء ربط الحجز' });
  }
};

export const getBookingStages = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.id || (req as any).user?.userId;
    const bookingRefOrId = req.params.id;

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const bookingRes = await pool.query(
      'SELECT id FROM bookings WHERE (id::text = $1 OR booking_reference = $1) AND user_id = $2',
      [bookingRefOrId, userId]
    );

    if (bookingRes.rows.length === 0) {
      res.status(404).json({ error: 'الحجز غير موجود' });
      return;
    }

    const bookingId = bookingRes.rows[0].id;

    let stagesRes = await pool.query(
      'SELECT * FROM trip_stages WHERE booking_id = $1 ORDER BY stage_order ASC',
      [bookingId]
    );

    if (stagesRes.rows.length === 0) {
      const currentDate = new Date().toLocaleDateString('ar-EG', { month: 'long', day: 'numeric', year: 'numeric' });
      const defaultStages = [
        { order: 1, title: 'تم استلام طلب الحجز', subtitle: 'تم إرسال الطلب بنجاح إلى الشركة', status: 'completed', date: currentDate },
        { order: 2, title: 'بانتظار مراجعة إيصال الدفع', subtitle: 'يرجى رفع إيصال السداد لمراجعة الشركة', status: 'current', date: currentDate },
        { order: 3, title: 'تأكيد الحجز النهائي', subtitle: 'قيد الانتظار لحين اعتماد الإيصال', status: 'pending', date: 'قريباً' },
        { order: 4, title: 'جارٍ تجهيز التأشيرات', subtitle: 'تصدُر بعد تأكيد الحجز واعتماد الإيصال من الشركة', status: 'pending', date: 'قريباً' },
        { order: 5, title: 'تم إصدار التأشيرات', subtitle: 'المستندات متاحة للتحميل في قسم مستندات رحلتي', status: 'pending', date: 'قريباً' },
        { order: 6, title: 'تذاكر الطيران والسكن', subtitle: 'حجز الفنادق وتذاكر الطيران الرسمية', status: 'pending', date: 'قريباً' },
        { order: 7, title: 'جاهزية الرحلة والتوجه للمطار', subtitle: 'تعليمات السفر والتجمع', status: 'pending', date: 'قريباً' },
        { order: 8, title: 'اكتملت الرحلة بسلام', subtitle: 'عمرة مقبولة وذنب مغفور', status: 'pending', date: 'العودة' },
      ];
      for (const st of defaultStages) {
        await pool.query(
          `INSERT INTO trip_stages (id, booking_id, stage_order, title, subtitle, status, stage_date) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [generate16CharId(), bookingId, st.order, st.title, st.subtitle, st.status, st.date]
        );
      }
      stagesRes = await pool.query(
        'SELECT * FROM trip_stages WHERE booking_id = $1 ORDER BY stage_order ASC',
        [bookingId]
      );
    }

    res.json({
      success: true,
      data: stagesRes.rows,
    });
  } catch (error: any) {
    console.error('Error fetching booking stages:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب مراحل الرحلة' });
  }
};
