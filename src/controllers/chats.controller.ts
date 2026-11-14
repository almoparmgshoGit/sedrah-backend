import { Response } from 'express';
import { AuthRequest } from '../middlewares/security.middleware';
import { pool } from '../config/db';
import { io } from '../server';
import { createAndSendNotification } from '../utils/notificationHelper';
import { sendPushToUsers } from '../utils/pushNotification';
import { generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { normalizeUploadUrl, resolveUserUpload } from '../utils/uploadAccess';
import { expireOverdueAppointmentsThrottled, isPastAppointmentDay, isPastAppointmentTime, localToday } from '../utils/appointmentLifecycle';
import { availableVisitSlots, toMinutes } from '../utils/appointmentEngine';
import { companyTeamUserIds, notifyCompanyTeam } from '../utils/companyAccess';
import { createAdminAlert, resolveAdminAlerts } from '../utils/adminAlerts';
import { getGrantedPermissions, canAccessModule } from '../middlewares/permission.middleware';
import { matchQuickQuestion, buildAutoReply, AUTO_REPLY_SENDER_NAME } from '../utils/chatAutoReply';

const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];

/** Staff read or act on other people's chats only with the support permission (super admins always may). */
const hasSupportAccess = async (req: AuthRequest): Promise<boolean> => {
  const role = req.user?.role as string | undefined;
  if (!req.user?.id || !role || !STAFF_ROLES.includes(role)) return false;
  return canAccessModule(await getGrantedPermissions(String(req.user.id), role), 'support');
};
const CUSTOMER_COMPANY_READ_ONLY_ERROR = 'محادثات العملاء مع الشركات للعرض فقط';
const INVALID_ATTACHMENT_ERROR = 'رابط المرفق غير صالح';

const PLATFORM_DESK_NAME = 'إدارة منصة سدرة الرسمية';
/*
 * closed:       closed, but a new message from the customer or company reopens it
 * closed_final: closed for good. Nobody can write on it or reopen it; a new matter needs a new ticket
 */
const TICKET_STATUSES = ['new', 'open', 'in_progress', 'resolved', 'closed', 'closed_final'];
const TICKET_STATUS_LABELS: Record<string, string> = {
  new: 'جديدة',
  open: 'مفتوحة',
  in_progress: 'قيد المتابعة',
  resolved: 'تم حلها',
  closed: 'مغلقة',
  closed_final: 'مغلقة نهائياً',
};
export const FINAL_CLOSED_ERROR = 'هذه التذكرة مغلقة نهائياً ولا يمكن الكتابة عليها أو إعادة فتحها. افتح تذكرة جديدة';

// What the support desk counts as a ticket (same rule as the is_ticket column of getAdminChats)
const isTicketChat = (chat: any) => Boolean(chat?.ticket_number) || chat?.company_name === PLATFORM_DESK_NAME;
const NOT_A_TICKET_ERROR = 'هذه محادثة بين عميل وشركة وليست تذكرة دعم';

const REMINDER_TEXT = '🔔 تذكير: هذه التذكرة بانتظار ردك.';
const REMINDER_COOLDOWN_MINUTES = 30;

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
    const res = await pool.query('SELECT id FROM chats WHERE id = $1 OR ticket_number = $1', [str]);
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

// Statuses in which the customer may pick a different visit time themselves; never after the visit or a company cancellation
const CUSTOMER_CHOOSABLE_STATUSES = ['pending', 'suggested', 'confirmed', 'rejected', 'expired', 'missed'];

/**
 * The company behind a customer's chat, and the customer's latest appointment with it (a company proposal,
 * or else the date set on a booking still waiting for its visit). Null when the chat is not this customer's.
 */
async function customerAppointmentContext(identifier: string | string[] | undefined, chatId: any, userId: string) {
  const resolved = await resolveChatTarget(identifier, chatId, userId);
  if (resolved.chat && resolved.chat.user_id !== userId) return null;
  const companyRes = await pool.query(
    'SELECT id, name, address FROM companies WHERE id::text = $1 OR name = $2 LIMIT 1',
    [String(resolved.companyId || ''), resolved.companyName || '']
  );
  const company = companyRes.rows[0];
  if (!company) return null;

  const apptRes = await pool.query(
    'SELECT * FROM interview_appointments WHERE user_id = $1 AND company_name = $2 ORDER BY created_at DESC LIMIT 1',
    [userId, company.name]
  );
  let latest: any = apptRes.rows[0] || null;
  if (!latest) {
    const bookingRes = await pool.query(
      `SELECT COALESCE(b.appointment_status, 'pending') AS status FROM bookings b JOIN packages p ON b.package_id = p.id
       WHERE b.user_id = $1 AND p.company_id = $2 AND b.status = 'new' AND b.appointment_date IS NOT NULL
       ORDER BY b.created_at DESC LIMIT 1`,
      [userId, company.id]
    );
    latest = bookingRes.rows[0] || null;
  }
  return { chatId: resolved.chatId, company, latest };
}

const NOT_CHOOSABLE_ERROR = 'لا يوجد موعد زيارة مع هذه الشركة يمكنك تغييره. تواصل مع الشركة';

// Choosing a time is checked and saved one customer at a time per company, so two customers never get the same slot
const companyLocks = new Map<string, Promise<unknown>>();
async function withCompanyLock<T>(companyId: string, task: () => Promise<T>): Promise<T> {
  const run = (companyLocks.get(companyId) || Promise.resolve()).catch(() => undefined).then(task);
  companyLocks.set(companyId, run);
  try {
    return await run;
  } finally {
    if (companyLocks.get(companyId) === run) companyLocks.delete(companyId);
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
      const isAdmin = await hasSupportAccess(req);
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
      const isStaffOrAdmin = isAdmin;
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
          isOfficialAdmin: targetCompanyName.includes('إدارة') || targetCompanyName.includes('ادارة') || targetCompanyName.includes('سدرة'),
          // A ticket's number and status, so the app shows its real state and stops writing on one closed for good
          ticket_number: chatInfo?.ticket_number || null,
          category_title: chatInfo?.category_title || null,
          context: chatInfo?.context || null,
          status: chatInfo?.ticket_number ? chatInfo?.status || 'open' : null,
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
      const isAdmin = await hasSupportAccess(req);
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
      // Staff follow a customer's chat with a company without writing in it; support tickets stay writable
      if (resolved.chat && resolved.chat.user_id !== userId && !isTicketChat(resolved.chat)) {
        res.status(403).json({ error: CUSTOMER_COMPANY_READ_ONLY_ERROR });
        return;
      }
      if (resolved.chat?.status === 'closed_final') {
        res.status(409).json({ error: FINAL_CLOSED_ERROR });
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
        io.to(`chat_${chatId}`).to(targetCompanyName).to('support_staff').emit('receive_message', createdMsg);
      }

      // A customer writing on a support ticket waits for the support desk; chats with companies are not the admins' to answer
      const ticket = await pool.query('SELECT ticket_number, context FROM chats WHERE id = $1 AND ticket_number IS NOT NULL', [chatId]);
      if (ticket.rows.length > 0) {
        await createAdminAlert({
          type: 'ticket_message',
          module: 'support',
          title: `رد جديد على التذكرة ${ticket.rows[0].ticket_number}`,
          body: String(message || '[صورة مرفقة]').slice(0, 200),
          entityType: 'chat',
          entityId: String(chatId),
          link: `/chats?id=${chatId}`,
          requiresAction: true,
          merge: true,
        });
      }

      // A suggested question in a chat with a company is answered at once from the company's profile
      let autoReply: any = null;
      let autoAnswered = false;
      const questionId = matchQuickQuestion(req.body.quickReplyId, message);
      if (questionId && targetCompanyId && !safeImageUri && ticket.rows.length === 0 && targetCompanyName !== PLATFORM_DESK_NAME) {
        try {
          const reply = await buildAutoReply(questionId, String(targetCompanyId));
          if (reply) {
            const replyRes = await pool.query(
              `INSERT INTO messages (id, chat_id, user_id, company_name, company_id, sender, text, time, status, sent_by_name)
               VALUES ($1, $2, $3, $4, $5, 'company', $6, $7, 'received', $8) RETURNING *`,
              [generate16CharId(), chatId, userId, targetCompanyName, targetCompanyId, reply.text, new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }), AUTO_REPLY_SENDER_NAME]
            );
            await pool.query(
              `UPDATE chats SET last_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
              [reply.text, chatId]
            );
            autoReply = replyRes.rows[0];
            autoAnswered = reply.answered;
            if (io) io.to(`chat_${chatId}`).to(targetCompanyName).emit('receive_message', autoReply);
          }
        } catch (err) {
          // The customer's message is already saved; without the automatic answer the team simply replies
          console.error('Chat auto-reply failed:', err);
        }
      }

      // Push notification to company owner for new chat message (skip if owner is currently viewing the chat).
      // A question already answered automatically does not need the team.
      if (targetCompanyId && !autoAnswered) {
        // The owner and every team member who handles chats
        const teamIds = await companyTeamUserIds(String(targetCompanyId), 'chats.view');
        if (teamIds.length > 0) {
          const socketsInRoom = io ? await io.in(`chat_${chatId}`).fetchSockets() : [];
          if (socketsInRoom.length === 0) {
            sendPushToUsers(
              teamIds,
              'رسالة جديدة',
              message || 'أرسل لك صورة جديدة',
              { type: 'chat_message', chatId, companyName: targetCompanyName },
              'company'
            ).catch(() => {});
          }
        }
      }

      res.status(201).json({ success: true, data: createdMsg, autoReply });
    } catch (error: any) {
      console.error('Error in sendMessage:', error);
      res.status(500).json({ error: 'فشل إرسال الرسالة' });
    }
  },

  async markAsRead(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const isAdmin = await hasSupportAccess(req);
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
      const isAdmin = await hasSupportAccess(req);
      const { companyName: identifier } = req.params;
      const chatIdQuery = req.query.chatId;

      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatIdQuery, userId, isAdmin);
      if (resolved.chat && resolved.chat.user_id !== userId && !isAdmin) {
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
      const isAdmin = await hasSupportAccess(req);
      const { companyName: identifier } = req.params;
      const { userId, chatId, appointmentDate, appointmentTime, title, location, notes } = req.body;

      // The customer is the one of the chat; only staff call this, so never fall back to the caller's own id
      let targetUserId = userId ? String(userId) : '';
      if (chatId) {
        const chatRes = await pool.query('SELECT id, user_id, department, ticket_number, company_name FROM chats WHERE id = $1', [String(chatId)]);
        const chat = chatRes.rows[0];
        if (!chat) {
          res.status(404).json({ error: 'المحادثة غير موجودة' });
          return;
        }
        if (chat.department === 'companies' && chat.ticket_number) {
          res.status(400).json({ error: 'لا يمكن تحديد موعد زيارة على تذكرة شركة' });
          return;
        }
        if (targetUserId && targetUserId !== String(chat.user_id)) {
          res.status(400).json({ error: 'العميل المحدد لا يطابق صاحب المحادثة' });
          return;
        }
        targetUserId = String(chat.user_id || '');
      }

      if (!targetUserId) {
        res.status(400).json({ error: 'معرف المستخدم مطلوب' });
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(appointmentDate || '')) || isPastAppointmentTime(appointmentDate, appointmentTime || '10:00 ص')) {
        res.status(400).json({ error: 'يرجى اختيار موعد لم يمضِ وقته بعد' });
        return;
      }

      const resolved = await resolveChatTarget(identifier, chatId, targetUserId, isAdmin);
      const finalChatId = chatId || resolved.chatId;
      const targetCompanyName = resolved.companyName;

      // The same appointment sent again moments later (double click, retried request) is not created twice
      const duplicate = await pool.query(
        `SELECT * FROM interview_appointments
         WHERE user_id = $1 AND company_name = $2 AND COALESCE(chat_id, '') = COALESCE($3, '')
           AND appointment_date = $4 AND appointment_time = $5 AND status = 'confirmed'
           AND created_at > NOW() - INTERVAL '2 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        [targetUserId, targetCompanyName, finalChatId ? String(finalChatId) : null, appointmentDate, appointmentTime || '10:00 ص']
      );
      if (duplicate.rows.length > 0) {
        res.status(200).json({ success: true, message: 'تم تحديد هذا الموعد بالفعل', data: duplicate.rows[0] });
        return;
      }

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
      const isAdmin = await hasSupportAccess(req);
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
      if (department && !['users', 'companies'].includes(department)) {
        res.status(400).json({ error: 'القسم غير صالح' });
        return;
      }
      if (!status && !department) {
        res.status(400).json({ error: 'لا يوجد تغيير مطلوب' });
        return;
      }

      const currentRes = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);
      const current = currentRes.rows[0];
      if (!current) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }
      if (!isTicketChat(current)) {
        res.status(400).json({ error: NOT_A_TICKET_ERROR });
        return;
      }
      if (current.status === 'closed_final') {
        res.status(409).json({ error: 'التذكرة مغلقة نهائياً ولا يمكن تغيير حالتها', data: current });
        return;
      }

      // Nothing changes: answer with the ticket as it is, without touching it or notifying anyone again
      const sameStatus = !status || (current.status || 'open') === status;
      const sameDepartment = !department || (current.department || 'users') === department;
      if (sameStatus && sameDepartment) {
        res.status(200).json({ success: true, data: current, unchanged: true });
        return;
      }

      // The old status is read in the same statement, so two admins changing it at once each see what they replaced
      const updateRes = await pool.query(
        `UPDATE chats c
         SET status = COALESCE($1, c.status),
             department = COALESCE($2, c.department),
             updated_at = CURRENT_TIMESTAMP
         FROM (SELECT id, status AS old_status FROM chats WHERE id = $3 FOR UPDATE) o
         WHERE c.id = o.id AND COALESCE(o.old_status, 'open') <> 'closed_final'
         RETURNING c.*, o.old_status`,
        [status || null, department || null, chatId]
      );

      if (updateRes.rows.length === 0) {
        // Closed for good by someone else a moment ago
        res.status(409).json({ error: 'التذكرة مغلقة نهائياً ولا يمكن تغيير حالتها' });
        return;
      }
      const statusChanged = Boolean(status) && (updateRes.rows[0].old_status || 'open') !== status;
      delete updateRes.rows[0].old_status;

      if (io) {
        io.to('support_staff').emit('ticket_updated', updateRes.rows[0]);
      }

      if (status === 'resolved' || status === 'closed' || status === 'closed_final') {
        await resolveAdminAlerts('chat', String(chatId), req.user?.email || null);
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
        const ticket = updateRes.rows[0];
        const ticketNum = ticket.ticket_number || `#T-${chatId}`;
        const statusArabic = TICKET_STATUS_LABELS[status];
        const payload = {
          title: 'تحديث حالة تذكرة الدعم',
          subtitle: `تم تحديث حالة تذكرتك ${ticketNum} إلى: (${statusArabic})`,
          category: 'support',
          icon: 'help-circle-outline',
          iconBg: '#F0FDF4',
          iconColor: '#16A34A',
        };
        // A company's ticket belongs to the company app and its support team, like the replies on it
        if (ticket.department === 'companies' && ticket.company_id && ticket.ticket_number) {
          notifyCompanyTeam(ticket.company_id, 'support.tickets', {
            ...payload,
            data: { type: 'support_reply', ticketId: ticket.id, status },
          }).catch(() => {});
        } else {
          createAndSendNotification({
            ...payload,
            userId: ticket.user_id,
            data: { type: 'ticket_update', chatId, status },
          }).catch(() => {});
        }
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

      if (!isTicketChat(chat)) {
        res.status(403).json({ error: CUSTOMER_COMPANY_READ_ONLY_ERROR });
        return;
      }

      if (chat.status === 'closed_final') {
        res.status(409).json({ error: 'التذكرة مغلقة نهائياً ولا يمكن الرد عليها' });
        return;
      }
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

      // On a ticket, the first staff member to reply takes ownership of it and the ticket moves to "in progress".
      // A chat between a customer and a company is not the desk's: it gets no owner and no ticket status.
      const staffRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user?.id]);
      const staffName = staffRes.rows[0]?.name || staffRes.rows[0]?.email || null;
      const ticket = isTicketChat(chat);
      await pool.query(
        `UPDATE chats
         SET last_message = $1,
             updated_at = CURRENT_TIMESTAMP,
             status = CASE WHEN $5::boolean AND COALESCE(status, 'open') IN ('new', 'open') THEN 'in_progress' ELSE status END,
             assigned_admin_id = CASE WHEN $5::boolean THEN COALESCE(assigned_admin_id, $2) ELSE assigned_admin_id END,
             assigned_admin_name = CASE WHEN $5::boolean THEN COALESCE(assigned_admin_name, $3) ELSE assigned_admin_name END
         WHERE id = $4`,
        [message || '[صورة مرفقة]', req.user?.id || null, staffName, chatId, ticket]
      );

      const createdMsg = msgRes.rows[0];

      if (io) {
        io.to(`chat_${chatId}`).to(chat.company_name).to('support_staff').emit('receive_message', createdMsg);
        io.to('support_staff').emit('ticket_updated', { id: chatId });
      }

      // The support desk answered, so the ticket's pending alerts are handled
      await resolveAdminAlerts('chat', String(chatId), staffName);

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
            { type: 'chat_message', chatId: chat.id, companyName: chat.company_name },
            'customer'
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
      // A ticket can only point at one of the customer's own bookings
      if (cleanBookingRef) {
        const bookingRes = await pool.query(
          'SELECT 1 FROM bookings WHERE booking_reference = $1 AND user_id = $2',
          [cleanBookingRef, targetUserId]
        );
        if (bookingRes.rows.length === 0) {
          res.status(400).json({ error: 'الحجز المحدد لا يخص هذا المستخدم' });
          return;
        }
      }
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
        io.to('support_staff').emit('ticket_updated', newChat.rows[0]);
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
        io.to('support_staff').emit('ticket_updated', newChat.rows[0]);
      }

      await createAdminAlert({
        type: 'ticket_created',
        module: 'support',
        title: `تذكرة دعم جديدة ${ticketNumber}`,
        body: `${title}: ${String(description).slice(0, 160)}`,
        entityType: 'chat',
        entityId: chatId,
        link: `/chats?id=${chatId}`,
        requiresAction: true,
      });

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
      // No adminId: the staff member takes the ticket for themselves ("استلام"). With one: an explicit reassignment.
      const isSelfClaim = !req.body?.adminId;
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

      const currentRes = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);
      const current = currentRes.rows[0];
      if (!current) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }
      if (!isTicketChat(current)) {
        res.status(400).json({ error: NOT_A_TICKET_ERROR });
        return;
      }
      if (current.status === 'closed' || current.status === 'closed_final') {
        res.status(409).json({ error: 'التذكرة مغلقة، أعد فتحها قبل إسنادها' });
        return;
      }
      // Already with this staff member: nothing to change, log or announce
      if (String(current.assigned_admin_id || '') === adminId) {
        res.status(200).json({ success: true, message: `التذكرة مسندة بالفعل إلى ${adminName}`, data: current, unchanged: true });
        return;
      }
      // Taking a ticket never takes it away from a colleague; moving it to someone else is done by reassigning
      if (isSelfClaim && current.assigned_admin_id) {
        res.status(409).json({ error: `التذكرة مستلمة بالفعل بواسطة ${current.assigned_admin_name || 'موظف آخر'}`, data: current });
        return;
      }

      // Checked again in the update itself: two staff members pressing "استلام" together never both get the ticket
      const updateRes = await pool.query(
        `UPDATE chats
         SET assigned_admin_id = $1,
             assigned_admin_name = $2,
             status = CASE WHEN COALESCE(status, 'open') IN ('new', 'open') THEN 'in_progress' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
           AND COALESCE(status, 'open') NOT IN ('closed', 'closed_final')
           AND (NOT $4::boolean OR assigned_admin_id IS NULL OR assigned_admin_id = $1)
         RETURNING *`,
        [adminId, adminName, chatId, isSelfClaim]
      );

      if (updateRes.rows.length === 0) {
        const latest = (await pool.query('SELECT * FROM chats WHERE id = $1', [chatId])).rows[0];
        if (!latest) {
          res.status(404).json({ error: 'التذكرة غير موجودة' });
        } else if (latest.status === 'closed' || latest.status === 'closed_final') {
          res.status(409).json({ error: 'التذكرة مغلقة، أعد فتحها قبل إسنادها', data: latest });
        } else {
          res.status(409).json({ error: `التذكرة مستلمة بالفعل بواسطة ${latest.assigned_admin_name || 'موظف آخر'}`, data: latest });
        }
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
        io.to('support_staff').emit('ticket_updated', updateRes.rows[0]);
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
      // Already gone (a second click, or another admin deleted it): nothing to log or announce
      if (deleted.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة أو حُذفت بالفعل' });
        return;
      }
      // Its pending alerts would otherwise point at a ticket that no longer exists
      await resolveAdminAlerts('chat', String(chatId), req.user?.email || null);
      await logAudit(
        req.user?.email || 'admin',
        'حذف تذكرة',
        `حذف التذكرة ${deleted.rows[0]?.ticket_number || chatId}`,
        req.ip,
        req.user?.email
      );
      if (io) {
        io.to('support_staff').emit('ticket_updated', { id: chatId, deleted: true });
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
        `UPDATE chats SET status = CASE WHEN status = 'closed_final' THEN status ELSE 'closed' END, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND (user_id = $2 OR $3 = true) RETURNING *`,
        [chatId, userId, req.user?.role === 'admin' || req.user?.role === 'super_admin']
      );

      if (updateRes.rows.length === 0) {
        res.status(404).json({ error: 'التذكرة غير موجودة' });
        return;
      }

      if (io) {
        io.to('support_staff').emit('ticket_updated', updateRes.rows[0]);
      }

      // Closed by the customer: nothing left for the support desk to do
      await resolveAdminAlerts('chat', String(chatId), 'العميل');

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

      if (!isTicketChat(chat)) {
        res.status(400).json({ error: NOT_A_TICKET_ERROR });
        return;
      }

      if (['closed', 'closed_final', 'resolved'].includes(chat.status)) {
        res.status(409).json({ error: 'لا يمكن إرسال تذكير على تذكرة مغلقة أو تم حلها' });
        return;
      }

      // A reminder asks the customer to answer; when the customer wrote last, the desk is the one who owes a reply
      const lastRes = await pool.query(
        'SELECT sender FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1',
        [chatId]
      );
      if (lastRes.rows[0]?.sender === 'user') {
        res.status(409).json({ error: 'العميل بانتظار ردك أنت، لا حاجة لتذكيره' });
        return;
      }

      // One reminder per ticket in a cooldown window, so the customer is never flooded
      const recentRes = await pool.query(
        `SELECT 1 FROM messages WHERE chat_id = $1 AND sender = 'company' AND text = $2
           AND created_at > NOW() - make_interval(mins => $3) LIMIT 1`,
        [chatId, REMINDER_TEXT, REMINDER_COOLDOWN_MINUTES]
      );
      if (recentRes.rows.length > 0) {
        res.status(429).json({ error: `تم إرسال تذكير مؤخراً، يمكنك التذكير مرة أخرى بعد ${REMINDER_COOLDOWN_MINUTES} دقيقة` });
        return;
      }

      const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      const reminderText = REMINDER_TEXT;

      const msgRes = await pool.query(
        `INSERT INTO messages (id, chat_id, user_id, company_name, sender, text, time, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [generate16CharId(), chatId, chat.user_id, chat.company_name, 'company', reminderText, timeStr, 'received']
      );
      await pool.query('UPDATE chats SET last_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [reminderText, chatId]);

      if (io) {
        io.to(`chat_${chatId}`).to('support_staff').emit('receive_message', msgRes.rows[0]);
        io.to('support_staff').emit('ticket_updated', { id: chatId });
      }

      const reminderPayload = {
        title: 'تذكير بخصوص تذكرة الدعم',
        subtitle: reminderText,
        category: 'support',
        icon: 'notifications-outline',
        iconBg: '#FEF3C7',
        iconColor: '#D97706',
      };
      // A company's ticket is answered from the company app by its support team, like every other reply on it
      if (chat.department === 'companies' && chat.company_id && chat.ticket_number) {
        notifyCompanyTeam(chat.company_id, 'support.tickets', {
          ...reminderPayload,
          data: { type: 'support_reply', ticketId: chat.id },
        }).catch(() => {});
      } else if (chat.user_id) {
        createAndSendNotification({
          ...reminderPayload,
          userId: chat.user_id,
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
      const isAdmin = await hasSupportAccess(req);
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
  },

  /** The company's free visit times, for a customer who wants a different time than the one proposed. */
  async getAppointmentSlots(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }
      const ctx = await customerAppointmentContext(req.params.companyName, req.query.chatId, userId);
      if (!ctx) {
        res.status(404).json({ error: 'الشركة غير موجودة' });
        return;
      }
      if (!ctx.latest || !CUSTOMER_CHOOSABLE_STATUSES.includes(ctx.latest.status)) {
        res.status(409).json({ error: NOT_CHOOSABLE_ERROR });
        return;
      }
      res.status(200).json({ success: true, data: await availableVisitSlots(ctx.company.id) });
    } catch (error: any) {
      console.error('Error in getAppointmentSlots:', error);
      res.status(500).json({ error: 'تعذر جلب المواعيد المتاحة' });
    }
  },

  /**
   * The customer picks one of the company's free times instead of the proposed one. It is checked again
   * against the company's free times, saved as confirmed, and the company is told.
   */
  async chooseAppointment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'غير مصرح' });
        return;
      }
      const { appointmentDate, appointmentTime, chatId } = req.body || {};
      const wantedMinutes = toMinutes(String(appointmentTime || ''));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(appointmentDate || '')) || wantedMinutes === null) {
        res.status(400).json({ error: 'اختر يوماً ووقتاً صحيحين' });
        return;
      }
      if (isPastAppointmentTime(appointmentDate, appointmentTime)) {
        res.status(400).json({ error: 'لا يمكن اختيار موعد مضى وقته' });
        return;
      }

      const ctx = await customerAppointmentContext(req.params.companyName, chatId, userId);
      if (!ctx) {
        res.status(404).json({ error: 'الشركة غير موجودة' });
        return;
      }
      if (!ctx.latest || !CUSTOMER_CHOOSABLE_STATUSES.includes(ctx.latest.status)) {
        res.status(409).json({ error: NOT_CHOOSABLE_ERROR });
        return;
      }
      const { company, latest } = ctx;

      const appointment = await withCompanyLock(String(company.id), async () => {
        const freeDay = (await availableVisitSlots(company.id)).find((day) => day.date === appointmentDate);
        const slot = freeDay?.times.find((time) => toMinutes(time) === wantedMinutes);
        if (!slot) return null;

        await pool.query(
          `UPDATE interview_appointments SET status = 'cancelled', status_changed_at = NOW(), status_reason = 'اختار العميل موعداً آخر'
           WHERE user_id = $1 AND company_name = $2 AND status IN ('pending', 'suggested', 'confirmed')`,
          [userId, company.name]
        );
        // The company's instructions (what to bring, where) carry over to the new time
        const inserted = await pool.query(
          `INSERT INTO interview_appointments (id, user_id, company_name, chat_id, title, appointment_date, appointment_time, location, notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed') RETURNING *`,
          [
            generate16CharId(), userId, company.name, ctx.chatId || null, latest.title || 'موعد مقابلة وزيارة',
            appointmentDate, slot, latest.location || company.address || 'مقر الشركة', latest.notes || '',
          ]
        );
        await pool.query(
          `UPDATE bookings b SET appointment_date = $1, appointment_time = $2, appointment_status = 'confirmed', appointment_reminder_sent_at = NULL
           FROM packages p WHERE b.package_id = p.id AND p.company_id = $3 AND b.user_id = $4 AND b.status = 'new'`,
          [appointmentDate, slot, company.id, userId]
        );
        return inserted.rows[0];
      });

      if (!appointment) {
        res.status(409).json({ error: 'هذا الموعد لم يعد متاحاً، اختر وقتاً آخر' });
        return;
      }

      const text = `📅 اخترت موعداً جديداً للزيارة: ${appointmentDate} الساعة ${appointment.appointment_time}`;
      if (ctx.chatId) {
        const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        const msgRes = await pool.query(
          `INSERT INTO messages (id, chat_id, user_id, company_name, company_id, sender, text, time, status)
           VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, 'sent') RETURNING *`,
          [generate16CharId(), ctx.chatId, userId, company.name, company.id, text, timeStr]
        );
        await pool.query('UPDATE chats SET last_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [text, ctx.chatId]);
        if (io) {
          io.to(`chat_${ctx.chatId}`).to(company.name).emit('receive_message', msgRes.rows[0]);
          io.to(`chat_${ctx.chatId}`).emit('appointment_updated', appointment);
        }
      }

      const customer = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      notifyCompanyTeam(company.id, 'appointments.view', {
        title: 'عميل اختار موعداً جديداً',
        subtitle: `اختار ${customer.rows[0]?.name || 'العميل'} موعد الزيارة ${appointmentDate} الساعة ${appointment.appointment_time}`,
        category: 'appointment',
        icon: 'calendar-outline',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        data: { type: 'appointment_chosen', appointmentDate },
      }).catch((err) => console.error('Failed to notify company of chosen appointment:', err));

      res.status(200).json({ success: true, message: 'تم حجز الموعد الجديد', data: appointment });
    } catch (error: any) {
      console.error('Error in chooseAppointment:', error);
      res.status(500).json({ error: 'تعذر حجز الموعد' });
    }
  }
};
