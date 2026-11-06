import { Response } from 'express';
import { AuthRequest } from '../middlewares/security.middleware';
import { pool } from '../config/db';
import { io } from '../server';
import { createAndSendNotification } from '../utils/notificationHelper';
import { sendPushToUsers } from '../utils/pushNotification';
import { generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { normalizeUploadUrl, resolveUserUpload } from '../utils/uploadAccess';
import { expireOverdueAppointmentsThrottled, isPastAppointmentDay, localToday } from '../utils/appointmentLifecycle';
import { companyTeamUserIds, notifyCompanyTeam } from '../utils/companyAccess';

const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];
const INVALID_ATTACHMENT_ERROR = 'رابط المرفق غير صالح';

const PLATFORM_DESK_NAME = 'إدارة منصة سدرة الرسمية';
const TICKET_STATUSES = ['new', 'open', 'in_progress', 'resolved', 'closed'];
const TICKET_STATUS_LABELS: Record<string, string> = {
  new: 'جديدة',
  open: 'مفتوحة',
  in_progress: 'قيد المتابعة',
  resolved: 'تم حلها',
  closed: 'مغلقة',
};

const generateTicketNumber = async (): Promise<string> => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = '#T-' + Math.floor(100000 + Math.random() * 900000);
    const exists = await pool.query('SELECT 1 FROM chats WHERE ticket_number = $1', [candidate]);
    if (exists.rows.length === 0) return candidate;
  }
  return '#T-' + Date.now();
};

interface ResolvedChatTarget {
  chatId: string | null;
  companyId: string | null;
  companyName: string;
  chat?: any;
}

async function resolveChatTarget(
  identifier: string | string[] | undefined,
  chatIdQuery: any,
  userId: string,
  isAdmin: boolean = false
): Promise<ResolvedChatTarget> {
  const rawStr = Array.isArray(identifier) ? identifier[0] : identifier;
  const decodedRaw = rawStr ? decodeURIComponent(String(rawStr).trim()) : '';

  if (chatIdQuery) {
    const chatRes = await pool.query('SELECT * FROM chats WHERE id = $1', [String(chatIdQuery).trim()]);
    if (chatRes.rows.length > 0) {
      const chat = chatRes.rows[0];
      return {
        chatId: chat.id,
        companyId: chat.company_id || null,
        companyName: chat.company_name,
        chat
      };
    }
  }

  if (decodedRaw) {
    // 1. Check if decodedRaw is a specific chat ID (unique chat)
    const chatByIdRes = await pool.query('SELECT * FROM chats WHERE id = $1', [decodedRaw]);
    if (chatByIdRes.rows.length > 0) {
      const chat = chatByIdRes.rows[0];
      return {
        chatId: chat.id,
        companyId: chat.company_id || null,
        companyName: chat.company_name,
        chat
      };
    }

    // 2. Check if decodedRaw is a company ID or company name for THIS user
    const userChatRes = await pool.query(
      'SELECT * FROM chats WHERE (user_id = $1 OR $2 = true) AND (company_id = $3 OR company_name = $3) ORDER BY created_at DESC LIMIT 1',
      [userId, isAdmin, decodedRaw]
    );
    if (userChatRes.rows.length > 0) {
      const chat = userChatRes.rows[0];
      return {
        chatId: chat.id,
        companyId: chat.company_id || null,
        companyName: chat.company_name,
        chat
      };
    }

    const compRes = await pool.query('SELECT id, name FROM companies WHERE id = $1 OR public_id = $2 OR name = $3', [decodedRaw, decodedRaw, decodedRaw]);
    if (compRes.rows.length > 0) {
      const company = compRes.rows[0];
      const userChatRes = await pool.query(
        'SELECT * FROM chats WHERE user_id = $1 AND ticket_number IS NULL AND (company_id = $2 OR company_name = $3) ORDER BY created_at DESC LIMIT 1',
        [userId, company.id, company.name]
      );
      if (userChatRes.rows.length > 0) {
        const chat = userChatRes.rows[0];
        return {
          chatId: chat.id,
          companyId: company.id,
          companyName: company.name,
          chat
        };
      }
      return {
        chatId: null,
        companyId: company.id,
        companyName: company.name
      };
    }

    if (decodedRaw.startsWith('#T-') || decodedRaw.startsWith('T-')) {
      const cleanNum = decodedRaw.startsWith('#') ? decodedRaw : `#${decodedRaw}`;
      const tRes = await pool.query(
        'SELECT * FROM chats WHERE ticket_number = $1 AND (user_id = $2 OR $3 = true) ORDER BY created_at DESC LIMIT 1',
        [cleanNum, userId, isAdmin]
      );
      if (tRes.rows.length > 0) {
        const chat = tRes.rows[0];
        return {
          chatId: chat.id,
          companyId: chat.company_id || null,
          companyName: chat.company_name,
          chat
        };
      }
    }
  }

  const companyName = decodedRaw || 'محادثة سدرة';
  const compByName = await pool.query('SELECT id, name FROM companies WHERE name = $1 LIMIT 1', [companyName]);
  const companyId = compByName.rows.length > 0 ? compByName.rows[0].id : null;

  const chatByName = await pool.query(
    'SELECT * FROM chats WHERE user_id = $1 AND ticket_number IS NULL AND (company_name = $2 OR (company_id IS NOT NULL AND company_id = $3)) ORDER BY created_at DESC LIMIT 1',
    [userId, companyName, companyId || '']
  );

  if (chatByName.rows.length > 0) {
    const chat = chatByName.rows[0];
    return {
      chatId: chat.id,
      companyId: chat.company_id || companyId,
      companyName: chat.company_name || companyName,
      chat
    };
  }

  return {
    chatId: null,
    companyId,
    companyName
  };
}

async function resolveChatId(param: string | string[] | number | undefined): Promise<string | null> {
  if (!param) return null;
  const rawStr = Array.isArray(param) ? param[0] : param;
  const str = String(rawStr).trim();
  try {
    const res = await pool.query('SELECT id FROM chats WHERE id = $1 OR ticket_number = $1', [str, str]);
    return res.rows.length > 0 ? res.rows[0].id : str;
  } catch (err) {
    try {
      const res2 = await pool.query('SELECT id FROM chats WHERE id = $1', [str]);
      return res2.rows.length > 0 ? res2.rows[0].id : str;
    } catch {
      return str;
    }
  }
}

export const chatsController = {
  async getUserChats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      let result = await pool.query(
        `SELECT c.*, comp.logo_url as company_logo, comp.verified as company_verified
         FROM chats c
         LEFT JOIN companies comp ON comp.name = c.company_name
         WHERE c.user_id = $1 AND c.company_name != 'إدارة منصة سدرة الرسمية' AND c.ticket_number IS NULL
         ORDER BY c.updated_at DESC`,
        [userId]
      );

      res.status(200).json({ success: true, data: result.rows });
    } catch (error: any) {
      console.error('Error in getUserChats:', error);
      res.status(500).json({ error: 'فشل جلب المحادثات' });
    }
  },

  async getChatMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const { companyName: identifier } = req.params;
      const chatIdQuery = req.query.chatId;

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      // Universal identifier resolver: supports chat ID, company ID, and company name
      const resolved = await resolveChatTarget(identifier, chatIdQuery, userId, isAdmin);
      let chatId = resolved.chatId;
      const targetCompanyName = resolved.companyName || 'محادثة سدرة';
      const targetCompanyId = resolved.companyId;

      // IDOR Authorization check
      const isStaffOrAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin' || (req.user?.role as string) === 'owner';
      if (resolved.chat && resolved.chat.user_id !== userId && !isStaffOrAdmin) {
        res.status(403).json({ error: 'غير مصرح لك بعرض هذه المحادثة' });
        return;
      }

      let chatInfo = resolved.chat;
      if (!chatId) {
        const compRes = await pool.query('SELECT id, logo_url, verified FROM companies WHERE name = $1 OR id = $2 LIMIT 1', [targetCompanyName, targetCompanyId || -1]);
        const compLogo = compRes.rows.length > 0 ? compRes.rows[0].logo_url : null;
        const compVerified = compRes.rows.length > 0 ? compRes.rows[0].verified : true;
        const finalCompId = compRes.rows.length > 0 ? compRes.rows[0].id : targetCompanyId;

        const newChatId = generate16CharId();
        const newChat = await pool.query(
          `INSERT INTO chats (id, user_id, company_name, company_id, context, last_message, unread_count, avatar, verified)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            newChatId,
            userId,
            targetCompanyName,
            finalCompId || null,
            'استفسار عام - التواصل المباشر',
            'مرحباً بك، كيف يمكننا مساعدتك في رحلتك؟',
            0,
            compLogo,
            compVerified
          ]
        );
        chatId = newChat.rows[0].id;
        chatInfo = newChat.rows[0];

        await pool.query(
          `INSERT INTO messages (id, chat_id, user_id, company_name, company_id, sender, text, time, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            generate16CharId(),
            chatId,
            userId,
            targetCompanyName,
            finalCompId || null,
            'company',
            'مرحباً بك، كيف يمكننا مساعدتك في رحلتك؟',
            new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
            'received'
          ]
        );
      }

      const messagesRes = await pool.query(
        'SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [chatId]
      );

      const compRes = await pool.query(
        'SELECT logo_url, verified FROM companies WHERE name = $1 OR id = $2 LIMIT 1',
        [targetCompanyName, targetCompanyId || -1]
      );
      const companyLogo = compRes.rows.length > 0 ? compRes.rows[0].logo_url : null;
      const companyVerified = compRes.rows.length > 0 ? compRes.rows[0].verified : true;

      res.status(200).json({
        success: true,
        data: messagesRes.rows,
        chatInfo: {
          chatId,
          companyId: targetCompanyId,
          companyName: targetCompanyName,
          companyLogo,
          companyVerified,
          isOfficialAdmin: targetCompanyName.includes('إدارة') || targetCompanyName.includes('ادارة') || targetCompanyName.includes('سدرة')
        }
      });
    } catch (error: any) {
      console.error('Error in getChatMessages:', error);
      res.status(500).json({ error: 'فشل جلب الرسائل' });
    }
  },

  async sendMessage(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const chatIdQuery = req.query.chatId || req.body.chatId;
      const { companyName: identifier } = req.params;
      const { message, imageUri } = req.body;

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      if (!message && !imageUri) {
        res.status(400).json({ error: 'محتوى الرسالة مطلوب' });
        return;
      }

      const safeImageUri = await resolveUserUpload(imageUri, req, userId);
      if (safeImageUri === false) {
        res.status(400).json({ error: INVALID_ATTACHMENT_ERROR });
        return;
      }

      // Universal identifier resolver: supports chat ID, company ID, and company name
      const resolved = await resolveChatTarget(identifier, chatIdQuery, userId, isAdmin);
      let chatId = resolved.chatId;
      const targetCompanyName = resolved.companyName || 'محادثة سدرة';
      const targetCompanyId = resolved.companyId;

      // IDOR Authorization check
      if (resolved.chat && resolved.chat.user_id !== userId && !isAdmin) {
        res.status(403).json({ error: 'غير مصرح لك بالإرسال في هذه المحادثة' });
        return;
      }

      if (!chatId) {
        const compRes = await pool.query('SELECT id, logo_url, verified FROM companies WHERE name = $1 OR id = $2 LIMIT 1', [targetCompanyName, targetCompanyId || -1]);
        const compLogo = compRes.rows.length > 0 ? compRes.rows[0].logo_url : null;
        const compVerified = compRes.rows.length > 0 ? compRes.rows[0].verified : true;
        const finalCompId = compRes.rows.length > 0 ? compRes.rows[0].id : targetCompanyId;

        const newChatId = generate16CharId();
        const newChat = await pool.query(
          `INSERT INTO chats (id, user_id, company_name, company_id, context, last_message, unread_count, avatar, verified)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            newChatId,
            userId,
            targetCompanyName,
            finalCompId || null,
            'استفسار عام - التواصل المباشر',
            message || '[صورة مرفقة]',
            0,
            compLogo,
            compVerified
          ]
        );
        chatId = newChat.rows[0].id;
      }

      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, company_id, sender, text, image_uri, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [generate16CharId(), chatId, userId, targetCompanyName, targetCompanyId || null, 'user', message || '[صورة مرفقة]', safeImageUri, timeStr, 'sent']
      );

      // Update chat last message & updated_at
      await pool.query(
        `UPDATE chats
         SET last_message = $1,
             updated_at = CURRENT_TIMESTAMP,
             status = CASE WHEN ticket_number IS NOT NULL AND status IN ('resolved', 'closed') THEN 'open' ELSE status END
         WHERE id = $2`,
        [message || '[صورة مرفقة]', chatId]
      );

      const createdMsg = msgRes.rows[0];

      if (io) {
        io.to(`chat_${chatId}`).to(targetCompanyName).to('staff').emit('receive_message', createdMsg);
      }

      // Push notification to company owner for new chat message (skip if owner is currently viewing the chat)
      if (targetCompanyId) {
        // The owner and every team member who handles chats
        const teamIds = await companyTeamUserIds(String(targetCompanyId), 'chats.view');
        if (teamIds.length > 0) {
          const socketsInRoom = io ? await io.in(`chat_${chatId}`).fetchSockets() : [];
          if (socketsInRoom.length === 0) {
            sendPushToUsers(
              teamIds,
              'رسالة جديدة',
              message || 'أرسل لك صورة جديدة',
              { type: 'chat_message', chatId, companyName: targetCompanyName }
            ).catch(() => {});
          }
        }
      }

      res.status(201).json({ success: true, data: createdMsg });
    } catch (error: any) {
      console.error('Error in sendMessage:', error);
      res.status(500).json({ error: 'فشل إرسال الرسالة' });
    }
  },

  async markAsRead(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const { companyName: identifier } = req.params;
      const chatIdQuery = req.query.chatId;

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatIdQuery, userId, isAdmin);

      if (resolved.chatId) {
        await pool.query(
          `UPDATE messages SET status = 'read' WHERE chat_id = $1 AND (user_id = $2 OR $3 = true)`,
          [resolved.chatId, userId, isAdmin]
        );
      } else if (resolved.companyName) {
        await pool.query(
          `UPDATE messages SET status = 'read' WHERE company_name = $1 AND user_id = $2`,
          [resolved.companyName, userId]
        );
      }

      res.status(200).json({ success: true, message: 'تم تحديث حالة الرسائل كمقروءة' });
    } catch (error: any) {
      console.error('Error in markAsRead:', error);
      res.status(500).json({ error: 'فشل تحديث حالة القراءة' });
    }
  },

  async getAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const { companyName: identifier } = req.params;
      const chatIdQuery = req.query.chatId;

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatIdQuery, userId, isAdmin);
      if (resolved.chat && resolved.chat.user_id !== userId && !STAFF_ROLES.includes(req.user?.role as string)) {
        res.status(403).json({ error: 'غير مصرح لك بعرض موعد هذه المحادثة' });
        return;
      }
      const targetChatId = resolved.chatId;
      const targetCompanyName = resolved.companyName;

      // Close anything whose day already ended, so the customer never sees a stale "confirmed" date
      await expireOverdueAppointmentsThrottled();

      let apptRes;
      if (targetChatId) {
        apptRes = await pool.query(
          'SELECT * FROM interview_appointments WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1',
          [targetChatId]
        );
      }
      if (!apptRes || apptRes.rows.length === 0) {
        apptRes = await pool.query(
          'SELECT * FROM interview_appointments WHERE (user_id = $1 OR $2 = true) AND company_name = $3 ORDER BY created_at DESC LIMIT 1',
          [userId, isAdmin, targetCompanyName]
        );
      }

      if (apptRes && apptRes.rows.length > 0) {
        const appt = apptRes.rows[0];
        res.status(200).json({
          success: true,
          data: {
            ...appt,
            appointmentType: 'sidra_interview',
            appointment_date: appt.appointment_date ? String(appt.appointment_date).split('T')[0] : '',
            status: appt.status || 'suggested',
          }
        });
        return;
      }

      // Fallback: Check if user has an active booking with this company that has appointment details
      const bookingAppt = await pool.query(
        `SELECT b.id, b.appointment_date, b.appointment_time, b.appointment_status, c.name as company_name
         FROM bookings b
         JOIN packages p ON b.package_id = p.id
         JOIN companies c ON p.company_id = c.id
         WHERE (b.user_id = $1 OR $2 = true) AND (c.name = $3 OR c.id = $4) AND b.appointment_date IS NOT NULL AND b.status != 'cancelled'
         ORDER BY b.created_at DESC LIMIT 1`,
        [userId, isAdmin, targetCompanyName, resolved.companyId || -1]
      );

      if (bookingAppt.rows.length > 0) {
        const b = bookingAppt.rows[0];
        res.status(200).json({
          success: true,
          data: {
            id: `b-${b.id}`,
            booking_id: b.id,
            user_id: userId,
            company_name: targetCompanyName,
            title: 'موعد زيارة مقر الشركة وتأكيد الحجز',
            appointment_date: b.appointment_date ? String(b.appointment_date).split('T')[0] : '',
            appointment_time: b.appointment_time ,
            location: 'مقر شركة ' + targetCompanyName,
            status: b.appointment_status || 'suggested',
            appointmentType: 'company_booking',
          }
        });
        return;
      }

      res.status(200).json({ success: true, data: null });
    } catch (error: any) {
      console.error('Error in getAppointment:', error);
      res.status(500).json({ error: 'فشل جلب موعد المقابلة' });
    }
  },

  async setAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const { companyName: identifier } = req.params;
      const { userId, chatId, appointmentDate, appointmentTime, title, location, notes } = req.body;
      const targetUserId = userId || req.user?.id;

      if (!targetUserId) {
        res.status(400).json({ error: 'معرف المستخدم مطلوب' });
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(appointmentDate || '')) || isPastAppointmentDay(appointmentDate)) {
        res.status(400).json({ error: 'يرجى اختيار تاريخ صحيح للموعد (اليوم أو بعده)' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatId, targetUserId, isAdmin);
      const finalChatId = chatId || resolved.chatId;
      const targetCompanyName = resolved.companyName;

      const apptId = generate16CharId();
      const insertRes = await pool.query(
        `INSERT INTO interview_appointments (id, user_id, company_name, chat_id, title, appointment_date, appointment_time, location, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed')
         RETURNING *`,
        [
          apptId,
          targetUserId,
          targetCompanyName,
          finalChatId || null,
          title || 'موعد مقابلة وزيارة',
          appointmentDate,
          appointmentTime || '10:00 ص',
          location || 'مقر الشركة',
          notes || ''
        ]
      );

      const appt = insertRes.rows[0];

      // Update the booking that is still waiting for this visit
      await pool.query(
        `UPDATE bookings b
         SET appointment_date = $1, appointment_time = $2, appointment_status = 'confirmed', appointment_reminder_sent_at = NULL
         FROM packages p, companies c
         WHERE b.package_id = p.id AND p.company_id = c.id AND b.user_id = $3 AND (c.name = $4 OR c.id = $5) AND b.status = 'new'`,
        [appointmentDate, appointmentTime || '10:00 ص', targetUserId, targetCompanyName, resolved.companyId || -1]
      );

      // Post system message into chat if finalChatId is known
      if (finalChatId) {
        const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const apptMsg = `📅 [تحديد موعد]: تم تحديد موعد رسمي بتاريخ ${appointmentDate} الساعة ${appointmentTime || '10:00 ص'} • ${location || 'مقر الشركة'}`;
        const msgRes = await pool.query(
          `INSERT INTO messages (id, chat_id, user_id, company_name, company_id, sender, text, time, status)
           VALUES ($1, $2, $3, $4, $5, 'company', $6, $7, 'received') RETURNING *`,
          [generate16CharId(), finalChatId, targetUserId, targetCompanyName, resolved.companyId || null, apptMsg, timeStr]
        );
        if (io) {
          io.to(`chat_${finalChatId}`).emit('receive_message', msgRes.rows[0]);
          io.to(`chat_${finalChatId}`).emit('appointment_updated', appt);
        }
      }

      if (targetUserId) {
        createAndSendNotification({
          userId: targetUserId,
          title: 'تحديد موعد مراجعة رسمي',
          subtitle: `تم تحديد موعد رسمي بتاريخ ${appointmentDate} الساعة ${appointmentTime || '10:00 ص'} في ${location || 'مقر الشركة'}`,
          category: 'appointment',
          icon: 'calendar-outline',
          iconBg: '#EFF6FF',
          iconColor: '#2563EB',
          data: { type: 'appointment', appointmentDate, location }
        }).catch(() => {});
      }

      res.status(201).json({ success: true, message: 'تم تحديد وحفظ الموعد بنجاح', data: appt });
    } catch (error: any) {
      console.error('Error in setAppointment:', error);
      res.status(500).json({ error: 'فشل تحديد الموعد' });
    }
  },

  async confirmAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const { companyName: identifier } = req.params;
      const { chatId } = req.body || req.query || {};

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatId, userId, isAdmin);
      if (resolved.chat && resolved.chat.user_id !== userId && !isAdmin) {
        res.status(403).json({ error: 'غير مصرح لك بتأكيد موعد هذه المحادثة' });
        return;
      }
      const targetChatId = resolved.chatId;
      const targetCompanyName = resolved.companyName;

      await expireOverdueAppointmentsThrottled();

      // Only the latest proposal still awaiting a reply; old, cancelled or missed ones stay as they are
      const pending = await pool.query(
        `SELECT * FROM interview_appointments
         WHERE user_id = $1 AND (company_name = $2 OR chat_id = $3) AND status IN ('pending', 'suggested')
         ORDER BY created_at DESC LIMIT 1`,
        [userId, targetCompanyName, targetChatId || '']
      );
      const proposal = pending.rows[0];

      if (proposal && isPastAppointmentDay(proposal.appointment_date)) {
        res.status(400).json({ error: 'انتهى يوم هذا الموعد ولا يمكن تأكيده. اطلب من الشركة تحديد موعد جديد' });
        return;
      }

      let updated: any = null;
      if (proposal) {
        const updateRes = await pool.query(
          `UPDATE interview_appointments SET status = 'confirmed', status_changed_at = NOW(), status_reason = NULL
           WHERE id = $1 RETURNING *`,
          [proposal.id]
        );
        updated = updateRes.rows[0];
      }

      // The booking's own suggested date, when the company has not sent a separate proposal
      const bookingRes = await pool.query(
        `UPDATE bookings b
         SET appointment_status = 'confirmed', appointment_reminder_sent_at = NULL
         FROM packages p, companies c
         WHERE b.package_id = p.id AND p.company_id = c.id AND b.user_id = $1 AND (c.name = $2 OR c.id = $3)
           AND b.status = 'new' AND b.appointment_status IN ('pending', 'suggested')
           AND (b.appointment_date IS NULL OR b.appointment_date >= $4::date)
         RETURNING b.id`,
        [userId, targetCompanyName, resolved.companyId || '', localToday()]
      );

      if (!updated && bookingRes.rows.length === 0) {
        res.status(409).json({ error: 'لا يوجد موعد بانتظار التأكيد' });
        return;
      }

      if (io && targetChatId) {
        io.to(`chat_${targetChatId}`).emit('appointment_updated', updated || { status: 'confirmed' });
      }

      res.status(200).json({ success: true, message: 'تم تأكيد الموعد بنجاح', data: updated || { status: 'confirmed' } });
    } catch (error: any) {
      console.error('Error in confirmAppointment:', error);
      res.status(500).json({ error: 'فشل تأكيد موعد المقابلة' });
    }
  },

  async getAdminChats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT c.*,
                (c.ticket_number IS NOT NULL OR c.company_name = $1) AS is_ticket,
                COALESCE(c.ticket_number, '#C-' || LEFT(c.id, 6)) as ticket_number,
                COALESCE(c.status, 'open') as ticket_status,
                COALESCE(c.department, 'users') as department,
                COALESCE(c.category_title, c.context, 'استفسار') as category_title,
                u.name as user_name, u.phone as user_phone, u.email as user_email,
                b.id as booking_id,
                b.status as booking_status,
                p.title as package_title,
                (SELECT sender FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_sender
         FROM chats c
         LEFT JOIN users u ON c.user_id = u.id
         LEFT JOIN bookings b ON c.booking_reference IS NOT NULL AND b.booking_reference = c.booking_reference
         LEFT JOIN packages p ON b.package_id = p.id
         ORDER BY c.updated_at DESC`,
        [PLATFORM_DESK_NAME]
      );
      res.status(200).json({ success: true, data: result.rows });
    } catch (error: any) {
      console.error('Error in getAdminChats:', error);
      res.status(500).json({ error: 'فشل جلب المحادثات للإدارة' });
    }
  },

  async getTicketRecipients(req: AuthRequest, res: Response): Promise<void> {
    try {
      const [users, companies, bookings, staff] = await Promise.all([
        pool.query(`SELECT id, name, phone, email FROM users WHERE COALESCE(role, 'user') = 'user' ORDER BY created_at DESC`),
        pool.query('SELECT id, name, user_id FROM companies ORDER BY name ASC'),
        pool.query(
          `SELECT b.id, b.user_id, b.booking_reference, b.status, p.title AS package_title
           FROM bookings b LEFT JOIN packages p ON b.package_id = p.id
           ORDER BY b.created_at DESC`
        ),
        pool.query(`SELECT id, name, email FROM users WHERE role IN ('admin', 'super_admin', 'support', 'moderator') ORDER BY name ASC`),
      ]);
      res.status(200).json({
        success: true,
        data: { users: users.rows, companies: companies.rows, bookings: bookings.rows, staff: staff.rows },
      });
    } catch (error: any) {
      console.error('Error in getTicketRecipients:', error);
      res.status(500).json({ error: 'فشل جلب بيانات إنشاء التذكرة' });
    }
  },

  async updateTicketStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      const { status, department } = req.body;

      if (status && !TICKET_STATUSES.includes(status)) {
        res.status(400).json({ error: 'حالة التذكرة غير صالحة' });
        return;
      }

      const previous = await pool.query('SELECT status FROM chats WHERE id = $1', [chatId]);
      const statusChanged = Boolean(status) && previous.rows[0]?.status !== status;

      const updateRes = await pool.query(
        `UPDATE chats
         SET status = COALESCE($1, status),
             department = COALESCE($2, department),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *`,
        [status || null, department || null, chatId]
      );

      if (updateRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }

      if (io) {
        io.to('staff').emit('ticket_updated', updateRes.rows[0]);
      }

      if (statusChanged) {
        await logAudit(
          req.user?.email || 'admin',
          'تحديث حالة تذكرة',
          `التذكرة ${updateRes.rows[0].ticket_number || chatId} إلى (${TICKET_STATUS_LABELS[status]})`,
          req.ip,
          req.user?.email
        );
      }

      if (statusChanged && updateRes.rows[0]?.user_id) {
        const ticketNum = updateRes.rows[0].ticket_number || `#T-${chatId}`;
        const statusArabic = TICKET_STATUS_LABELS[status];
        createAndSendNotification({
          userId: updateRes.rows[0].user_id,
          title: 'تحديث حالة تذكرة الدعم',
          subtitle: `تم تحديث حالة تذكرتك ${ticketNum} إلى: (${statusArabic})`,
          category: 'support',
          icon: 'help-circle-outline',
          iconBg: '#F0FDF4',
          iconColor: '#16A34A',
          data: { type: 'ticket_update', chatId, status }
        }).catch(() => {});
      }

      res.status(200).json({ success: true, data: updateRes.rows[0] });
    } catch (error: any) {
      console.error('Error in updateTicketStatus:', error);
      res.status(500).json({ error: 'فشل تحديث حالة التذكرة' });
    }
  },

  async getAdminChatMessages(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      const messagesRes = await pool.query(
        'SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [chatId]
      );
      res.status(200).json({ success: true, data: messagesRes.rows });
    } catch (error: any) {
      console.error('Error in getAdminChatMessages:', error);
      res.status(500).json({ error: 'فشل جلب رسائل المحادثة للإدارة' });
    }
  },

  async sendAdminChatMessage(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      const { message, imageUri } = req.body;

      if (!message && !imageUri) {
        res.status(400).json({ error: 'محتوى الرسالة مطلوب' });
        return;
      }

      const safeImageUri = normalizeUploadUrl(imageUri, req);
      if (safeImageUri === false) {
        res.status(400).json({ error: INVALID_ATTACHMENT_ERROR });
        return;
      }

      const chatRes = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);
      if (chatRes.rows.length === 0) {
        res.status(404).json({ error: 'المحادثة غير موجودة' });
        return;
      }
      const chat = chatRes.rows[0];

      if (chat.status === 'closed') {
        res.status(409).json({ error: 'التذكرة مغلقة، أعد فتحها أولاً' });
        return;
      }

      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, image_uri, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [generate16CharId(), chatId, chat.user_id, chat.company_name, 'company', message || '[صورة مرفقة]', safeImageUri, timeStr, 'received']
      );

      // The first staff member to reply takes ownership of an unassigned ticket
      const staffRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user?.id]);
      const staffName = staffRes.rows[0]?.name || staffRes.rows[0]?.email || null;
      await pool.query(
        `UPDATE chats
         SET last_message = $1,
             updated_at = CURRENT_TIMESTAMP,
             status = CASE WHEN ticket_number IS NOT NULL AND status IN ('new', 'open') THEN 'in_progress' ELSE status END,
             assigned_admin_id = COALESCE(assigned_admin_id, $2),
             assigned_admin_name = COALESCE(assigned_admin_name, $3)
         WHERE id = $4`,
        [message || '[صورة مرفقة]', req.user?.id || null, staffName, chatId]
      );

      const createdMsg = msgRes.rows[0];

      if (io) {
        io.to(`chat_${chatId}`).to(chat.company_name).to('staff').emit('receive_message', createdMsg);
        io.to('staff').emit('ticket_updated', { id: chatId });
      }

      if (chat.department === 'companies' && chat.company_id && chat.ticket_number) {
        await notifyCompanyTeam(chat.company_id, 'support.tickets', {
          title: `رد من دعم سدرة · ${chat.ticket_number}`,
          subtitle: message || 'أرسل لكم الدعم صورة',
          category: 'support',
          icon: 'headset-outline',
          iconBg: '#EFF6FF',
          iconColor: '#2563EB',
          data: { type: 'support_reply', ticketId: chat.id },
        }).catch(() => {});
      } else if (chat.user_id) {
        const socketsInRoom = io ? await io.in(`chat_${chatId}`).fetchSockets() : [];
        if (socketsInRoom.length === 0) {
          sendPushToUsers(
            [chat.user_id],
            chat.company_name || 'إدارة منصة سدرة',
            message || 'أرسل لك صورة جديدة',
            { type: 'chat_message', chatId: chat.id, companyName: chat.company_name }
          ).catch(() => {});
        }
      }

      res.status(201).json({ success: true, data: createdMsg });
    } catch (error: any) {
      console.error('Error in sendAdminChatMessage:', error);
      res.status(500).json({ error: 'فشل إرسال رد الإدارة' });
    }
  },

  async createAdminInitiatedChat(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { userId, companyId, context, initialMessage, bookingReference } = req.body;

      if (!String(context || '').trim() || !String(initialMessage || '').trim()) {
        res.status(400).json({ error: 'موضوع التذكرة والرسالة مطلوبان' });
        return;
      }

      let targetUserId: string;
      let targetCompanyName = PLATFORM_DESK_NAME;
      let targetCompanyId: string | null = null;
      let department = 'users';

      if (companyId) {
        const companyRes = await pool.query('SELECT id, name, user_id FROM companies WHERE id = $1', [String(companyId)]);
        if (companyRes.rows.length === 0) {
          res.status(404).json({ error: 'الشركة غير موجودة' });
          return;
        }
        if (!companyRes.rows[0].user_id) {
          res.status(400).json({ error: 'لا يوجد مالك مرتبط بهذه الشركة، اربطها بمستخدم أولاً' });
          return;
        }
        targetUserId = String(companyRes.rows[0].user_id);
        targetCompanyId = companyRes.rows[0].id;
        targetCompanyName = companyRes.rows[0].name;
        department = 'companies';
      } else if (userId) {
        const userRes = await pool.query('SELECT id FROM users WHERE id = $1', [String(userId)]);
        if (userRes.rows.length === 0) {
          res.status(404).json({ error: 'المستخدم غير موجود' });
          return;
        }
        targetUserId = String(userId);
      } else {
        res.status(400).json({ error: 'يرجى اختيار مستخدم أو شركة' });
        return;
      }

      const cleanBookingRef = bookingReference ? String(bookingReference).trim() : null;
      const ticketNumber = await generateTicketNumber();
      const title = String(context).trim();
      const initialText = String(initialMessage).trim();
      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      const creatorRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user?.id]);
      const creatorName = creatorRes.rows[0]?.name || creatorRes.rows[0]?.email || null;

      const compRes = await pool.query('SELECT logo_url FROM companies WHERE name = $1 LIMIT 1', [targetCompanyName]);
      const avatarUrl = compRes.rows.length > 0 ? compRes.rows[0].logo_url : null;

      const newChatId = generate16CharId();
      const newChat = await pool.query(
        `INSERT INTO chats (id, user_id, company_name, company_id, context, last_message, unread_count, avatar, verified, ticket_number, category_title, booking_reference, status, department, assigned_admin_id, assigned_admin_name)
         VALUES ($1, $2, $3, $14, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $15, $16) RETURNING *`,
        [
          newChatId,
          targetUserId,
          targetCompanyName,
          title,
          initialText,
          0,
          avatarUrl,
          true,
          ticketNumber,
          title,
          cleanBookingRef,
          'in_progress',
          department,
          targetCompanyId,
          req.user?.id || null,
          creatorName
        ]
      );

      const chatId = newChat.rows[0].id;

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [generate16CharId(), chatId, targetUserId, targetCompanyName, 'company', initialText, timeStr, 'received']
      );

      if (io) {
        io.to(`chat_${chatId}`).emit('receive_message', msgRes.rows[0]);
        io.to(targetCompanyName).emit('receive_message', msgRes.rows[0]);
        io.to('staff').emit('ticket_updated', newChat.rows[0]);
      }

      // A ticket with a company reaches its whole support team, not only the owner
      if (targetCompanyId) {
        notifyCompanyTeam(targetCompanyId, 'support.tickets', {
          title: `تذكرة جديدة من دعم سدرة · ${ticketNumber}`,
          subtitle: `${title}: ${initialText}`.slice(0, 200),
          category: 'support',
          icon: 'headset-outline',
          iconBg: '#EFF6FF',
          iconColor: '#2563EB',
          data: { type: 'support_reply', ticketId: chatId },
        }).catch(() => {});
      } else if (targetUserId) {
        createAndSendNotification({
          userId: targetUserId!,
          title: 'محادثة جديدة من الإدارة',
          subtitle: initialText,
          category: 'chat',
          icon: 'chatbubble-ellipses-outline',
          iconBg: '#EFF6FF',
          iconColor: '#2563EB',
          data: { type: 'admin_chat', chatId }
        }).catch(() => {});
      }

      res.status(201).json({ success: true, data: { id: chatId, ...newChat.rows[0] } });
    } catch (error: any) {
      console.error('Error in createAdminInitiatedChat:', error);
      res.status(500).json({ error: 'فشل إنشاء وإعادة تشغيل المحادثة الإدارية' });
    }
  },

  async createSupportTicket(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const { ticketType, title, description, attachmentUrl, bookingReference } = req.body;
      if (!title || !description) {
        res.status(400).json({ error: 'عنوان التذكرة والوصف مطلوبان' });
        return;
      }

      const safeAttachmentUrl = await resolveUserUpload(attachmentUrl, req, userId);
      if (safeAttachmentUrl === false) {
        res.status(400).json({ error: INVALID_ATTACHMENT_ERROR });
        return;
      }

      const ticketNumber = await generateTicketNumber();
      const companyName = PLATFORM_DESK_NAME;
      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      const newChatId = generate16CharId();
      const newChat = await pool.query(
        `INSERT INTO chats (id, user_id, company_name, context, last_message, unread_count, avatar, verified, ticket_number, ticket_type, description, attachment_url, category_title, booking_reference, status, department)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [
          newChatId,
          userId,
          companyName,
          title,
          description,
          0,
          null,
          true,
          ticketNumber,
          ticketType || 'general',
          description,
          safeAttachmentUrl,
          title,
          bookingReference || null,
          'new',
          'users'
        ]
      );

      const chatId = newChat.rows[0].id;

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, image_uri, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [generate16CharId(), chatId, userId, companyName, 'user', description, safeAttachmentUrl, timeStr, 'sent']
      );

      if (io) {
        io.to(`chat_${chatId}`).emit('receive_message', msgRes.rows[0]);
        io.to('staff').emit('ticket_updated', newChat.rows[0]);
      }

      // Push notification to admins for new support ticket
      const adminUsers = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin', 'support')");
      const adminIds = adminUsers.rows.map((r: any) => r.id);
      if (adminIds.length > 0) {
        sendPushToUsers(
          adminIds,
          'تذكرة دعم جديدة',
          `${title}: ${description.substring(0, 100)}`,
          { type: 'new_support_ticket', chatId, ticketNumber }
        ).catch(() => {});
      }

      res.status(201).json({
        success: true,
        message: 'تم إنشاء تذكرة الدعم الفني بنجاح',
        data: newChat.rows[0]
      });
    } catch (error: any) {
      console.error('Error in createSupportTicket:', error);
      res.status(500).json({ error: 'فشل إنشاء تذكرة الدعم' });
    }
  },

  async assignAndOpenTicket(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      const adminId = req.body?.adminId ? String(req.body.adminId) : String(req.user?.id || '');

      const staffRes = await pool.query(
        `SELECT id, name, email FROM users WHERE id = $1 AND role IN ('admin', 'super_admin', 'support', 'moderator')`,
        [adminId]
      );
      if (staffRes.rows.length === 0) {
        res.status(400).json({ error: 'الموظف المحدد غير صالح' });
        return;
      }
      const adminName = staffRes.rows[0].name || staffRes.rows[0].email;

      const updateRes = await pool.query(
        `UPDATE chats
         SET assigned_admin_id = $1,
             assigned_admin_name = $2,
             status = CASE WHEN status IN ('new', 'open') THEN 'in_progress' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *`,
        [adminId, adminName, chatId]
      );

      if (updateRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }

      await logAudit(
        req.user?.email || 'admin',
        'إسناد تذكرة',
        `التذكرة ${updateRes.rows[0].ticket_number || chatId} أُسندت إلى ${adminName}`,
        req.ip,
        req.user?.email
      );

      if (io) {
        io.to('staff').emit('ticket_updated', updateRes.rows[0]);
      }

      res.status(200).json({
        success: true,
        message: `تم إسناد التذكرة إلى ${adminName}`,
        data: updateRes.rows[0]
      });
    } catch (error: any) {
      console.error('Error in assignAndOpenTicket:', error);
      res.status(500).json({ error: 'فشل إسناد التذكرة' });
    }
  },

  async deleteTicketAdmin(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      const deleted = await pool.query('DELETE FROM chats WHERE id = $1 RETURNING ticket_number', [chatId]);
      await logAudit(
        req.user?.email || 'admin',
        'حذف تذكرة',
        `حذف التذكرة ${deleted.rows[0]?.ticket_number || chatId}`,
        req.ip,
        req.user?.email
      );
      if (io) {
        io.to('staff').emit('ticket_updated', { id: chatId, deleted: true });
      }
      res.status(200).json({ success: true, message: 'تم حذف التذكرة بنجاح' });
    } catch (error: any) {
      console.error('Error in deleteTicketAdmin:', error);
      res.status(500).json({ error: 'فشل حذف التذكرة' });
    }
  },

  async getUserSupportTickets(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const result = await pool.query(
        `SELECT c.*,
                COALESCE(c.ticket_number, '#T-' || LEFT(c.id, 6)) as ticket_number,
                COALESCE(c.category_title, c.context, 'استفسار عن حجز') as category_title,
                COALESCE(c.status, 'open') as status,
                (SELECT sender FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_sender
         FROM chats c
         WHERE c.user_id = $1 AND (c.company_name = 'إدارة منصة سدرة الرسمية' OR c.ticket_number IS NOT NULL)
         ORDER BY c.updated_at DESC`,
        [userId]
      );

      res.status(200).json({ success: true, data: result.rows });
    } catch (error: any) {
      console.error('Error in getUserSupportTickets:', error);
      res.status(500).json({ error: 'فشل جلب تذاكر الدعم' });
    }
  },

  async requestCloseTicket(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const chatId = await resolveChatId(req.params.chatId);

      const updateRes = await pool.query(
        `UPDATE chats SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND (user_id = $2 OR $3 = true) RETURNING *`,
        [chatId, userId, req.user?.role === 'admin' || req.user?.role === 'super_admin']
      );

      if (updateRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }

      if (io) {
        io.to('staff').emit('ticket_updated', updateRes.rows[0]);
      }

      res.status(200).json({ success: true, message: 'تم إغلاق التذكرة بنجاح', data: updateRes.rows[0] });
    } catch (error: any) {
      console.error('Error in requestCloseTicket:', error);
      res.status(500).json({ error: 'فشل إغلاق التذكرة' });
    }
  },

  async sendTicketReminder(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      
      const chatRes = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);
      if (chatRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }
      const chat = chatRes.rows[0];

      if (chat.status === 'closed') {
        res.status(409).json({ error: 'لا يمكن إرسال تذكير على تذكرة مغلقة' });
        return;
      }

      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      const reminderText = '🔔 تذكير: هذه التذكرة بانتظار ردك.';

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [generate16CharId(), chatId, chat.user_id, chat.company_name, 'company', reminderText, timeStr, 'received']
      );

      if (io) {
        io.to(`chat_${chatId}`).to('staff').emit('receive_message', msgRes.rows[0]);
      }

      // Push notification to user for ticket reminder
      if (chat.user_id) {
        createAndSendNotification({
          userId: chat.user_id,
          title: 'تذكير بخصوص تذكرة الدعم',
          subtitle: reminderText,
          category: 'support',
          icon: 'notifications-outline',
          iconBg: '#FEF3C7',
          iconColor: '#D97706',
          data: { type: 'ticket_reminder', chatId }
        }).catch(() => {});
      }

      res.status(201).json({ success: true, message: 'تم إرسال التذكير بنجاح', data: msgRes.rows[0] });
    } catch (error: any) {
      console.error('Error in sendTicketReminder:', error);
      res.status(500).json({ error: 'فشل إرسال التذكير' });
    }
  },

  async rejectAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';
      const { companyName: identifier } = req.params;
      const { chatId } = req.body;

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatId, userId, isAdmin);
      if (resolved.chat && resolved.chat.user_id !== userId && !isAdmin) {
        res.status(403).json({ error: 'غير مصرح لك برفض موعد هذه المحادثة' });
        return;
      }
      const targetChatId = resolved.chatId;
      const targetUserId = resolved.chat?.user_id || userId;

      // Only the latest appointment that is still open can be declined
      const updateRes = await pool.query(
        `UPDATE interview_appointments
         SET status = 'rejected', status_changed_at = NOW(), status_reason = 'رفض العميل الموعد'
         WHERE id = (
           SELECT id FROM interview_appointments
           WHERE user_id = $1 AND (chat_id = $2 OR company_name = $3) AND status IN ('pending', 'suggested', 'confirmed')
           ORDER BY created_at DESC LIMIT 1
         )
         RETURNING *`,
        [targetUserId, targetChatId || '', resolved.companyName]
      );

      const bookingRes = await pool.query(
        `UPDATE bookings b
         SET appointment_status = 'rejected'
         FROM packages p, companies c
         WHERE b.package_id = p.id AND p.company_id = c.id AND b.user_id = $1 AND (c.name = $2 OR c.id = $3)
           AND b.status = 'new' AND b.appointment_status IN ('pending', 'suggested', 'confirmed')
         RETURNING b.id`,
        [targetUserId, resolved.companyName, resolved.companyId || '']
      );

      if (updateRes.rows.length === 0 && bookingRes.rows.length === 0) {
        res.status(409).json({ error: 'لا يوجد موعد مفتوح يمكن رفضه' });
        return;
      }

      if (io && targetChatId) {
        io.to(`chat_${targetChatId}`).emit('appointment_updated', updateRes.rows[0] || { status: 'rejected' });
      }

      res.status(200).json({ success: true, message: 'تم رفض الموعد بنجاح', data: updateRes.rows[0] || null });
    } catch (error: any) {
      console.error('Error in rejectAppointment:', error);
      res.status(500).json({ error: 'فشل رفض الموعد' });
    }
  }
};
