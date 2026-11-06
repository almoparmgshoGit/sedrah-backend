import { Response } from 'express';
import { pool } from '../config/db';
import { io } from '../server';
import { generate16CharId } from '../utils/formatId';
import { resolveUserUpload } from '../utils/uploadAccess';
import { sendPushToUsers } from '../utils/pushNotification';
import { logCompanyActivity } from '../utils/companyAccess';
import type { CompanyRequest } from './company.controller';

/*
 * Support tickets between a company and the platform. They are the same chats the admin support desk works
 * with (ticket_number set, department "companies"), so tickets the admin opens with the company and tickets
 * the company opens with the admin appear in one list on both sides. In these chats the company writes as
 * "user" and the platform staff as "company", which is how the support desk already stores them.
 */

const TICKET_FILTER = `c.ticket_number IS NOT NULL AND c.department = 'companies'
  AND (c.company_id = $1 OR (c.company_id IS NULL AND c.company_name = $2))`;

const CATEGORIES: Record<string, string> = {
  general: 'استفسار عام',
  payments: 'المدفوعات والعمولات',
  packages: 'الباقات',
  bookings: 'الحجوزات',
  account: 'الحساب والتوثيق',
  technical: 'مشكلة تقنية',
};

const generateTicketNumber = async (): Promise<string> => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = '#T-' + Math.floor(100000 + Math.random() * 900000);
    const exists = await pool.query('SELECT 1 FROM chats WHERE ticket_number = $1', [candidate]);
    if (exists.rows.length === 0) return candidate;
  }
  return '#T-' + Date.now();
};

const findTicket = async (req: CompanyRequest) => {
  const result = await pool.query(`SELECT c.* FROM chats c WHERE c.id = $3 AND ${TICKET_FILTER}`, [
    req.company.id,
    req.company.name,
    String(req.params.id),
  ]);
  return result.rows[0] || null;
};

const notifyStaff = async (title: string, body: string, data: Record<string, any>) => {
  const staff = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'super_admin', 'support')");
  const ids = staff.rows.map((row: any) => row.id);
  if (ids.length > 0) sendPushToUsers(ids, title, body, data).catch(() => {});
};

export const listCompanyTickets = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.ticket_number, COALESCE(c.category_title, c.context) AS title, c.ticket_type, c.status,
         c.last_message, c.updated_at, c.created_at, c.booking_reference, c.assigned_admin_name,
         (SELECT m.sender FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at ASC LIMIT 1) = 'company' AS opened_by_platform,
         (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id AND m.sender = 'company' AND m.status <> 'read') AS unread,
         (SELECT sender FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender
       FROM chats c WHERE ${TICKET_FILTER}
       ORDER BY CASE WHEN c.status = 'closed' THEN 1 ELSE 0 END, c.updated_at DESC
       LIMIT 200`,
      [req.company.id, req.company.name]
    );
    res.json({ success: true, data: result.rows, categories: CATEGORIES });
  } catch (error) {
    console.error('List company tickets error:', error);
    res.status(500).json({ error: 'تعذر جلب تذاكر الدعم' });
  }
};

export const createCompanyTicket = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const { title, message, category, bookingReference, attachmentUrl } = req.body;
    const attachment = await resolveUserUpload(attachmentUrl, req, req.user!.id);
    if (attachment === false) {
      res.status(400).json({ error: 'المرفق غير صالح، ارفعه مرة أخرى' });
      return;
    }
    const ticketNumber = await generateTicketNumber();
    const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const chatId = generate16CharId();
    const created = await pool.query(
      `INSERT INTO chats (id, user_id, company_name, company_id, context, last_message, unread_count, avatar, verified, ticket_number,
         ticket_type, description, attachment_url, category_title, booking_reference, status, department)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, true, $8, $9, $6, $10, $5, $11, 'new', 'companies') RETURNING *`,
      [
        chatId, req.user!.id, req.company.name, req.company.id, title, message, req.company.logo_url || null,
        ticketNumber, CATEGORIES[category] ? category : 'general', attachment || null, bookingReference || null,
      ]
    );
    await pool.query(
      `INSERT INTO messages (id, chat_id, user_id, company_id, company_name, sender, text, image_uri, time, status, sent_by_name)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8, 'sent', $9)`,
      [generate16CharId(), chatId, req.user!.id, req.company.id, req.company.name, message, attachment || null, timeStr, req.actor?.name || null]
    );
    if (io) io.to('staff').emit('ticket_updated', created.rows[0]);
    await notifyStaff('تذكرة جديدة من شركة', `${req.company.name}: ${title}`, { type: 'new_support_ticket', chatId, ticketNumber });
    await logCompanyActivity(req.company.id, req.actor || {}, 'ticket_created', `فتح تذكرة دعم ${ticketNumber}: ${title}`, 'ticket', chatId);
    res.status(201).json({ success: true, message: 'تم إرسال التذكرة لفريق دعم سدرة', data: { id: chatId, ticket_number: ticketNumber } });
  } catch (error) {
    console.error('Create company ticket error:', error);
    res.status(500).json({ error: 'تعذر إنشاء التذكرة' });
  }
};

export const getCompanyTicketMessages = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const ticket = await findTicket(req);
    if (!ticket) {
      res.status(404).json({ error: 'التذكرة غير موجودة' });
      return;
    }
    await pool.query(`UPDATE messages SET status = 'read' WHERE chat_id = $1 AND sender = 'company' AND status <> 'read'`, [ticket.id]);
    const messages = await pool.query(
      `SELECT id, sender, text, image_uri, time, status, created_at, sent_by_name FROM messages WHERE chat_id = $1 ORDER BY created_at ASC LIMIT 500`,
      [ticket.id]
    );
    res.json({
      success: true,
      data: {
        ticket: {
          id: ticket.id,
          ticket_number: ticket.ticket_number,
          title: ticket.category_title || ticket.context,
          status: ticket.status,
          booking_reference: ticket.booking_reference,
          assigned_admin_name: ticket.assigned_admin_name,
          created_at: ticket.created_at,
        },
        messages: messages.rows,
      },
    });
  } catch (error) {
    console.error('Company ticket messages error:', error);
    res.status(500).json({ error: 'تعذر جلب رسائل التذكرة' });
  }
};

export const sendCompanyTicketMessage = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const ticket = await findTicket(req);
    if (!ticket) {
      res.status(404).json({ error: 'التذكرة غير موجودة' });
      return;
    }
    const image = await resolveUserUpload(req.body.imageUri, req, req.user!.id);
    if (image === false) {
      res.status(400).json({ error: 'المرفق غير صالح، ارفعه مرة أخرى' });
      return;
    }
    const text = String(req.body.message || '').trim() || (image ? '[صورة مرفقة]' : '');
    const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    const inserted = await pool.query(
      `INSERT INTO messages (id, chat_id, user_id, company_id, company_name, sender, text, image_uri, time, status, sent_by_name)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8, 'sent', $9)
       RETURNING id, sender, text, image_uri, time, status, created_at, sent_by_name`,
      [generate16CharId(), ticket.id, ticket.user_id, req.company.id, req.company.name, text, image || null, timeStr, req.actor?.name || null]
    );
    // Writing on a closed ticket reopens it for the support desk
    await pool.query(
      `UPDATE chats SET last_message = $1, updated_at = CURRENT_TIMESTAMP,
         status = CASE WHEN status = 'closed' THEN 'new' ELSE status END
       WHERE id = $2`,
      [text, ticket.id]
    );
    const message = { ...inserted.rows[0], chat_id: ticket.id };
    if (io) {
      io.to(`chat_${ticket.id}`).to('staff').emit('receive_message', message);
      io.to('staff').emit('ticket_updated', { id: ticket.id });
    }
    await notifyStaff(`رد من ${req.company.name}`, text.slice(0, 120), { type: 'chat_message', chatId: ticket.id });
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    console.error('Company ticket message error:', error);
    res.status(500).json({ error: 'تعذر إرسال الرسالة' });
  }
};

export const closeCompanyTicket = async (req: CompanyRequest, res: Response): Promise<void> => {
  try {
    const ticket = await findTicket(req);
    if (!ticket) {
      res.status(404).json({ error: 'التذكرة غير موجودة' });
      return;
    }
    await pool.query(`UPDATE chats SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [ticket.id]);
    if (io) io.to('staff').emit('ticket_updated', { id: ticket.id, status: 'closed' });
    await logCompanyActivity(req.company.id, req.actor || {}, 'ticket_closed', `أغلق تذكرة الدعم ${ticket.ticket_number}`, 'ticket', ticket.id);
    res.json({ success: true, message: 'تم إغلاق التذكرة' });
  } catch (error) {
    console.error('Close company ticket error:', error);
    res.status(500).json({ error: 'تعذر إغلاق التذكرة' });
  }
};
