import { pool } from '../config/db';
import { sendPushToUsers } from './pushNotification';
import { generate16CharId } from './formatId';

export interface NotificationPayload {
  userId: string;
  title: string;
  subtitle: string;
  category?: string;
  icon?: string;
  iconBg?: string;
  iconColor?: string;
  system?: string; // 'bookings' | 'store' | 'chats' | 'tickets'
  statusKey?: string; // e.g. 'confirmed', 'shipped', 'delivered', etc.
  variables?: Record<string, any>;
  data?: Record<string, any>;
}

/**
 * حفظ الإشعار في قاعدة البيانات وإرسال Push Notification فعلي للجهاز في خطوة واحدة
 * مع دعم القوالب الديناميكية المخصصة من الإدارة واستبدال المتغيرات
 */
export async function createAndSendNotification(opts: NotificationPayload): Promise<void> {
  if (!opts.userId) return;

  try {
    let finalTitle = opts.title;
    let finalSubtitle = opts.subtitle;
    let finalCategory = opts.category || 'عام';
    let finalIcon = opts.icon || 'notifications-outline';
    let finalIconBg = opts.iconBg || 'bg-emerald-50 border-emerald-100';
    let finalIconColor = opts.iconColor || '#059669';

    // البحث عن قالب مخصص مفعل في النظام إذا تم تحديد النظام أو الحالة
    const system = opts.system || (
      opts.category === 'store' ? 'store' :
      opts.category === 'bookings' ? 'bookings' :
      opts.category === 'chats' ? 'chats' :
      opts.category === 'tickets' ? 'tickets' : null
    );
    const statusKey = opts.statusKey || opts.data?.status || opts.data?.type;

    if (system && statusKey) {
      try {
        const cleanKey = String(statusKey).trim().toLowerCase();
        const tplRes = await pool.query(
          'SELECT * FROM notification_templates WHERE system = $1 AND status_key = $2 AND is_active = true LIMIT 1',
          [system, cleanKey]
        );

        if (tplRes.rows.length > 0) {
          const tpl = tplRes.rows[0];

          // استخراج المتغيرات المتاحة للاستبدال
          const vars: Record<string, any> = {
            customer_name: '',
            order_number: opts.data?.orderNumber || opts.data?.order_number || '',
            booking_number: opts.data?.bookingNumber || opts.data?.booking_id || '',
            package_name: opts.data?.packageName || '',
            company_name: opts.data?.companyName || 'سدرة',
            stage_title: opts.data?.stageTitle || opts.data?.stage_title || '',
            ticket_number: opts.data?.ticketNumber || opts.data?.ticket_id || '',
            ticket_subject: opts.data?.ticketSubject || '',
            sender_name: opts.data?.senderName || 'خدمة العملاء',
            agent_name: opts.data?.agentName || 'ممثل الخدمة',
            message_preview: opts.data?.messagePreview || opts.data?.message || '',
            reply_preview: opts.data?.replyPreview || opts.data?.reply || '',
            destination: opts.data?.destination || '',
            total_amount: opts.data?.totalAmount || '',
            ...(opts.variables || {})
          };

          if (!vars.customer_name) {
            try {
              const uRes = await pool.query('SELECT name FROM users WHERE id = $1', [opts.userId]);
              vars.customer_name = uRes.rows[0]?.name || 'عزيزنا العميل';
            } catch {}
          }

          let renderedTitle = tpl.title;
          let renderedSubtitle = tpl.subtitle;

          for (const [k, v] of Object.entries(vars)) {
            const reg = new RegExp(`\\{${k}\\}`, 'gi');
            renderedTitle = renderedTitle.replace(reg, String(v || ''));
            renderedSubtitle = renderedSubtitle.replace(reg, String(v || ''));
          }

          finalTitle = renderedTitle;
          finalSubtitle = renderedSubtitle;
          if (tpl.category) finalCategory = tpl.category;
          if (tpl.icon) finalIcon = tpl.icon;
          if (tpl.icon_bg) finalIconBg = tpl.icon_bg;
          if (tpl.icon_color) finalIconColor = tpl.icon_color;
        }
      } catch (tplErr) {
        console.warn('Could not apply notification template:', tplErr);
      }
    }

    // 1. الحفظ في جدول الإشعارات الداخلية للتطبيق
    await pool.query(
      `INSERT INTO notifications (id, user_id, title, subtitle, category, icon, icon_bg, icon_color, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
      [generate16CharId(), opts.userId, finalTitle, finalSubtitle, finalCategory, finalIcon, finalIconBg, finalIconColor]
    );

    // 2. إرسال Push Notification حقيقي للجهاز (يظهر في لوحة إشعارات الهاتف)
    await sendPushToUsers(
      [opts.userId],
      finalTitle,
      finalSubtitle,
      { ...(opts.data || {}), category: finalCategory }
    );

    console.log(`📲 Notification & Push sent to user ${opts.userId}: "${finalTitle}"`);
  } catch (error) {
    console.error(`❌ Failed to send notification & push to user ${opts.userId}:`, error);
  }
}
