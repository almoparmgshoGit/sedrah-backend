import { Response } from 'express';
import { AuthRequest } from '../middlewares/security.middleware';
import { pool } from '../config/db';
import { io } from '../server';
import { createAndSendNotification } from '../utils/notificationHelper';
import { sendPushToUsers } from '../utils/pushNotification';
import { generate16CharId } from '../utils/formatId';

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
    const chatRes = await pool.query('SELECT * FROM chats WHERE id = $1 OR public_id = $1 OR company_name = $2', [decodedRaw, decodedRaw]);
    if (chatRes.rows.length > 0) {
      const chat = chatRes.rows[0];
      return {
        chatId: chat.id,
        companyId: chat.company_id || null,
        companyName: chat.company_name,
        chat
      };
    }

    const compRes = await pool.query('SELECT id, name FROM companies WHERE id = $1 OR public_id = $1 OR name = $2', [decodedRaw, decodedRaw]);
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
      if (resolved.chat && resolved.chat.user_id !== userId && !isAdmin) {
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
        'SELECT * FROM messages WHERE chat_id = $1 ORDER BY id ASC',
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
        [generate16CharId(), chatId, userId, targetCompanyName, targetCompanyId || null, 'user', message || '[صورة مرفقة]', imageUri || null, timeStr, 'sent']
      );

      // Update chat last message & updated_at
      await pool.query(
        'UPDATE chats SET last_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [message || '[صورة مرفقة]', chatId]
      );

      const createdMsg = msgRes.rows[0];

      if (io) {
        io.to(`chat_${chatId}`).emit('receive_message', createdMsg);
        io.to(targetCompanyName).emit('receive_message', createdMsg);
      }

      // Push notification to company owner for new chat message (skip if owner is currently viewing the chat)
      if (targetCompanyId) {
        const compOwner = await pool.query('SELECT user_id FROM companies WHERE id = $1', [targetCompanyId]);
        if (compOwner.rows.length > 0 && compOwner.rows[0].user_id) {
          const socketsInRoom = io ? await io.in(`chat_${chatId}`).fetchSockets() : [];
          if (socketsInRoom.length === 0) {
            sendPushToUsers(
              [compOwner.rows[0].user_id],
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
      const targetChatId = resolved.chatId;
      const targetCompanyName = resolved.companyName;

      let apptRes;
      if (targetChatId) {
        apptRes = await pool.query(
          'SELECT * FROM interview_appointments WHERE chat_id = $1 ORDER BY id DESC LIMIT 1',
          [targetChatId]
        );
      }
      if (!apptRes || apptRes.rows.length === 0) {
        apptRes = await pool.query(
          'SELECT * FROM interview_appointments WHERE (user_id = $1 OR $2 = true) AND company_name = $3 ORDER BY id DESC LIMIT 1',
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
         ORDER BY b.id DESC LIMIT 1`,
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

      // Update active booking if exists
      await pool.query(
        `UPDATE bookings b
         SET appointment_date = $1, appointment_time = $2, appointment_status = 'confirmed'
         FROM packages p, companies c
         WHERE b.package_id = p.id AND p.company_id = c.id AND b.user_id = $3 AND (c.name = $4 OR c.id = $5) AND b.status != 'cancelled'`,
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
      const targetChatId = chatId || resolved.chatId;
      const targetCompanyName = resolved.companyName;

      const updateRes = await pool.query(
        `UPDATE interview_appointments
         SET status = 'confirmed'
         WHERE user_id = $1 AND (company_name = $2 OR chat_id = $3)
         RETURNING *`,
        [userId, targetCompanyName, targetChatId || -1]
      );

      // Also update in bookings
      await pool.query(
        `UPDATE bookings b
         SET appointment_status = 'confirmed'
         FROM packages p, companies c
         WHERE b.package_id = p.id AND p.company_id = c.id AND b.user_id = $1 AND (c.name = $2 OR c.id = $3)`,
        [userId, targetCompanyName, resolved.companyId || -1]
      );

      if (io && targetChatId) {
        io.to(`chat_${targetChatId}`).emit('appointment_updated', { status: 'confirmed' });
      }

      res.status(200).json({ success: true, message: 'تم تأكيد الموعد بنجاح', data: updateRes.rows[0] || { status: 'confirmed' } });
    } catch (error: any) {
      console.error('Error in confirmAppointment:', error);
      res.status(500).json({ error: 'فشل تأكيد موعد المقابلة' });
    }
  },

  async getAdminChats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT c.*,
                COALESCE(c.ticket_number, '#T-' || LEFT(c.id, 6)) as ticket_number,
                COALESCE(c.status, 'open') as ticket_status,
                COALESCE(c.department, 'users') as department,
                COALESCE(c.category_title, c.context, 'استفسار عن حجز') as category_title,
                u.name as user_name, u.phone as user_phone, u.email as user_email,
                COALESCE(b_ref.id, b_user.id) as booking_id,
                COALESCE(c.booking_reference, b_user.booking_reference) as booking_reference,
                COALESCE(b_ref.status, b_user.status) as booking_status,
                COALESCE(p_ref.title, p_user.title) as package_title
         FROM chats c
         LEFT JOIN users u ON c.user_id = u.id
         LEFT JOIN bookings b_ref ON c.booking_reference IS NOT NULL AND b_ref.booking_reference = c.booking_reference
         LEFT JOIN packages p_ref ON b_ref.package_id = p_ref.id
         LEFT JOIN LATERAL (
           SELECT b.id, b.booking_reference, b.status, b.package_id FROM bookings b WHERE b.user_id = c.user_id ORDER BY b.id DESC LIMIT 1
         ) b_user ON c.booking_reference IS NULL
         LEFT JOIN packages p_user ON b_user.package_id = p_user.id
         ORDER BY c.updated_at DESC`
      );
      res.status(200).json({ success: true, data: result.rows });
    } catch (error: any) {
      console.error('Error in getAdminChats:', error);
      res.status(500).json({ error: 'فشل جلب المحادثات للإدارة' });
    }
  },

  async updateTicketStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      const { status, department } = req.body;

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
        io.emit('ticket_updated', updateRes.rows[0]);
      }

      if (updateRes.rows[0]?.user_id) {
        const ticketNum = updateRes.rows[0].ticket_number || `#T-${chatId}`;
        const statusMap: Record<string, string> = {
          open: 'مفتوحة',
          in_progress: 'قيد المتابعة',
          resolved: 'تم حلها',
          closed: 'مغلقة'
        };
        const statusArabic = statusMap[status] || status || 'محدثة';
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
        'SELECT * FROM messages WHERE chat_id = $1 ORDER BY id ASC',
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

      const chatRes = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);
      if (chatRes.rows.length === 0) {
        res.status(404).json({ error: 'المحادثة غير موجودة' });
        return;
      }
      const chat = chatRes.rows[0];

      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, image_uri, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [generate16CharId(), chatId, chat.user_id, chat.company_name, 'company', message || '[صورة مرفقة]', imageUri || null, timeStr, 'received']
      );

      await pool.query(
        'UPDATE chats SET last_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [message || '[صورة مرفقة]', chatId]
      );

      const createdMsg = msgRes.rows[0];

      if (io) {
        io.to(`chat_${chatId}`).emit('receive_message', createdMsg);
        io.to(chat.company_name).emit('receive_message', createdMsg);
      }

      if (chat.user_id) {
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
      const { userId, companyName, context, initialMessage, bookingReference } = req.body;

      let targetUserId = userId ? String(userId) : (req.user?.id ? String(req.user.id) : null);
      let targetCompanyName = companyName || 'إدارة منصة سدرة الرسمية';

      if (!targetUserId) {
        const userRes = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
        targetUserId = userRes.rows.length > 0 ? String(userRes.rows[0].id) : '1';
      }

      const cleanBookingRef = bookingReference ? String(bookingReference).trim() : null;
      const ticketNumber = '#T-' + Math.floor(10000 + Math.random() * 90000);
      const title = context || 'استفسار إداري جديد';
      const initialText = initialMessage || 'مرحباً بك، تواصل رسمي وخاص من إدارة منصة سدرة';
      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      const compRes = await pool.query('SELECT logo_url FROM companies WHERE name = $1 LIMIT 1', [targetCompanyName]);
      const avatarUrl = compRes.rows.length > 0 ? compRes.rows[0].logo_url : null;

      const newChatId = generate16CharId();
      const newChat = await pool.query(
        `INSERT INTO chats (id, user_id, company_name, context, last_message, unread_count, avatar, verified, ticket_number, category_title, booking_reference, status, department)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
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
          'open',
          'users'
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
        io.emit('ticket_updated', newChat.rows[0]);
      }

      // Push notification to user for admin-initiated chat
      if (targetUserId) {
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

      const ticketNumber = '#T-' + Math.floor(10000 + Math.random() * 90000);
      const companyName = 'إدارة منصة سدرة الرسمية';
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
          attachmentUrl || null,
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
        [generate16CharId(), chatId, userId, companyName, 'user', description, attachmentUrl || null, timeStr, 'sent']
      );

      if (io) {
        io.to(`chat_${chatId}`).emit('receive_message', msgRes.rows[0]);
        io.emit('ticket_updated', newChat.rows[0]);
      }

      // Push notification to admins for new support ticket
      const adminUsers = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
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
      const adminName = (req.user as any)?.name || req.user?.email || 'م. أحمد محمد - الدعم الفني';
      const adminId = req.user?.id || null;

      const updateRes = await pool.query(
        `UPDATE chats
         SET assigned_admin_id = $1,
             assigned_admin_name = $2,
             status = 'open',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 RETURNING *`,
        [adminId, adminName, chatId]
      );

      if (updateRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }

      if (io) {
        io.emit('ticket_updated', updateRes.rows[0]);
      }

      res.status(200).json({
        success: true,
        message: `تم استلام التذكرة من قبل ${adminName}`,
        data: updateRes.rows[0]
      });
    } catch (error: any) {
      console.error('Error in assignAndOpenTicket:', error);
      res.status(500).json({ error: 'فشل استلام التذكرة: ' + (error.message || '') });
    }
  },

  async deleteTicketAdmin(req: AuthRequest, res: Response): Promise<void> {
    try {
      const chatId = await resolveChatId(req.params.chatId);
      await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);
      if (io) {
        io.emit('ticket_updated', { id: chatId, deleted: true });
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
                (SELECT sender FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_sender
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
        io.emit('ticket_updated', updateRes.rows[0]);
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
      const userId = req.user?.id;

      const chatRes = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);
      if (chatRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }
      const chat = chatRes.rows[0];

      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      const reminderText = '🔔 [تذكير إداري]: تم إرسال تذكير بخصوص هذه التذكرة لعدم الرد لأكثر من 12 ساعة.';

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [generate16CharId(), chatId, chat.user_id, chat.company_name, 'company', reminderText, timeStr, 'received']
      );

      if (io) {
        io.emit('receive_message', msgRes.rows[0]);
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
          data: { type: 'ticket_reminder', chatId: parseInt(chatId as string) }
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

      let targetChatId = chatId;
      if (!targetChatId && identifier) {
        const chatMatch = await pool.query('SELECT id FROM chats WHERE id = $1 OR company_name = $2 ORDER BY updated_at DESC LIMIT 1', [identifier, identifier]);
        if (chatMatch.rows.length > 0) targetChatId = chatMatch.rows[0].id;
      }

      const updateRes = await pool.query(
        `UPDATE interview_appointments
         SET status = 'rejected'
         WHERE chat_id = $1 OR user_id = $2
         RETURNING *`,
        [targetChatId || null, userId]
      );

      await pool.query(
        `UPDATE bookings SET appointment_status = 'rejected' WHERE user_id = $1 AND appointment_status != 'cancelled'`,
        [userId]
      );

      if (io && targetChatId) {
        io.to(`chat_${targetChatId}`).emit('appointment_updated', { status: 'rejected' });
      }

      res.status(200).json({ success: true, message: 'تم رفض الموعد بنجاح', data: updateRes.rows[0] || null });
    } catch (error: any) {
      console.error('Error in rejectAppointment:', error);
      res.status(500).json({ error: 'فشل رفض الموعد' });
    }
  }
};
