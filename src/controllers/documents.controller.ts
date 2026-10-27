import { Request, Response } from 'express';
import { pool } from '../config/db';

export const getBookingDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const userId = user?.id || user?.userId;
    const userRole = user?.role;
    const bookingIdParam = req.params.bookingId;

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    // Find booking with joined user name
    let bookingResult;
    if (userRole === 'admin' || userRole === 'super_admin') {
      bookingResult = await pool.query(
        `SELECT b.id, b.booking_reference, b.travelers_count, b.package_id, b.receipt_url, b.receipt_approved, b.receipt_status, COALESCE(u.name, 'عميل المنصة') AS customer_name, b.created_at
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
         WHERE (b.id::text = $1 OR b.booking_reference = $1)`,
        [bookingIdParam]
      );
      if (bookingResult.rows.length === 0) {
        bookingResult = await pool.query(
          `SELECT b.id, b.booking_reference, b.travelers_count, b.package_id, b.receipt_url, b.receipt_approved, b.receipt_status, COALESCE(u.name, 'عميل المنصة') AS customer_name, b.created_at
           FROM bookings b
           LEFT JOIN users u ON u.id = b.user_id
           ORDER BY b.created_at DESC LIMIT 1`
        );
      }
    } else {
      bookingResult = await pool.query(
        `SELECT b.id, b.booking_reference, b.travelers_count, b.package_id, b.receipt_url, b.receipt_approved, b.receipt_status, COALESCE(u.name, 'عميل المنصة') AS customer_name, b.created_at
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
         WHERE (b.id::text = $1 OR b.booking_reference = $1) AND b.user_id = $2`,
        [bookingIdParam, userId]
      );
      if (bookingResult.rows.length === 0) {
        bookingResult = await pool.query(
          `SELECT b.id, b.booking_reference, b.travelers_count, b.package_id, b.receipt_url, b.receipt_approved, b.receipt_status, COALESCE(u.name, 'عميل المنصة') AS customer_name, b.created_at
           FROM bookings b
           LEFT JOIN users u ON u.id = b.user_id
           WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 1`,
          [userId]
        );
      }
    }

    if (!bookingResult || bookingResult.rows.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const booking = bookingResult.rows[0];

    // Check if documents exist in documents table for this booking
    let documents: any[] = [];
    try {
      const docsResult = await pool.query('SELECT * FROM documents WHERE booking_id = $1', [booking.id]);
      documents = [...docsResult.rows];
    } catch (docErr) {
      console.warn('Warning: Could not fetch from documents table:', docErr);
    }

    // Add booking payment receipt if available
    if (booking.receipt_url) {
      const hasReceiptDoc = documents.some(
        d => d.file_url === booking.receipt_url || d.document_type === 'receipt' || d.document_type === 'payment_receipt'
      );
      if (!hasReceiptDoc) {
        documents.push({
          id: `booking-receipt-${booking.id}`,
          booking_id: booking.id,
          document_type: 'receipt',
          traveler_name: booking.customer_name || 'إيصال الدفع المالي',
          document_number: booking.booking_reference || `SDR-${booking.id}`,
          file_url: booking.receipt_url,
          status: booking.receipt_approved ? 'approved' : 'available',
          created_at: booking.created_at || new Date()
        });
      }
    }

    // Fetch documents uploaded in trip stages
    try {
      const stagesResult = await pool.query(
        'SELECT * FROM trip_stages WHERE booking_id = $1 AND (document_url IS NOT NULL OR details IS NOT NULL) ORDER BY stage_order ASC',
        [booking.id]
      );

      for (const st of stagesResult.rows) {
        const titleStr = String(st.title || '');
        let docType = 'visa';
        if (titleStr.includes('تذاكر') || titleStr.includes('طيران')) docType = 'ticket';
        else if (titleStr.includes('السكن') || titleStr.includes('الفندق')) docType = 'hotel';
        else if (titleStr.includes('إيصال') || titleStr.includes('الايصال') || titleStr.includes('دفع')) docType = 'receipt';

        if (st.details) {
          try {
            const parsed = JSON.parse(st.details);
            if (Array.isArray(parsed)) {
              for (const tr of parsed) {
                if (tr && tr.docUrl) {
                  documents.push({
                    id: `stage-${st.id}-${tr.name || 'traveler'}`,
                    booking_id: booking.id,
                    document_type: docType,
                    traveler_name: tr.name || 'مسافر',
                    document_number: tr.docNumber || '',
                    file_url: tr.docUrl,
                    status: 'available',
                    created_at: st.created_at || new Date()
                  });
                }
              }
            }
          } catch (e) {
            // Ignore malformed JSON in details
          }
        } else if (st.document_url) {
          documents.push({
            id: `stage-${st.id}`,
            booking_id: booking.id,
            document_type: docType,
            traveler_name: st.traveler_name || 'مسافر',
            document_number: st.document_number || '',
            file_url: st.document_url,
            status: 'available',
            created_at: st.created_at || new Date()
          });
        }
      }
    } catch (stageErr) {
      console.warn('Warning: Could not fetch stage documents:', stageErr);
    }

    // Ensure any receipt document is strictly classified as 'receipt'
    documents = documents.map(doc => {
      const urlStr = String(doc.file_url || '');
      const numStr = String(doc.document_number || '');
      const nameStr = String(doc.traveler_name || '');
      if (doc.document_type === 'visa' && (urlStr.includes('receipt') || numStr.includes('SDR') || nameStr.includes('إيصال'))) {
        return { ...doc, document_type: 'receipt' };
      }
      return doc;
    });

    res.json({
      success: true,
      data: documents,
    });
  } catch (error: any) {
    console.error('Error fetching documents in controller:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب المستندات' });
  }
};
