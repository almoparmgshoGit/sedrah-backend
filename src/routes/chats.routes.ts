import { Router } from 'express';
import { chatsController } from '../controllers/chats.controller';
import { authenticate, authorize, idempotencyMiddleware } from '../middlewares/security.middleware';
import { requireModulePermission } from '../middlewares/permission.middleware';

const router = Router();

const supportStaff = [authenticate, authorize(), requireModulePermission('support')];
// Support desk actions that change something: a repeated request with the same idempotency key is answered once
const supportStaffWrite = [...supportStaff, idempotencyMiddleware];

router.get('/', authenticate, chatsController.getUserChats);
router.post('/tickets', authenticate, idempotencyMiddleware, chatsController.createSupportTicket);
router.get('/tickets/user', authenticate, chatsController.getUserSupportTickets);
router.patch('/tickets/:chatId/close', authenticate, chatsController.requestCloseTicket);
router.post('/tickets/:chatId/remind', supportStaffWrite, chatsController.sendTicketReminder);

router.get('/admin/all', supportStaff, chatsController.getAdminChats);
router.get('/admin/recipients', supportStaff, chatsController.getTicketRecipients);
router.post('/admin/initiate', supportStaffWrite, chatsController.createAdminInitiatedChat);
router.get('/admin/:chatId/messages', supportStaff, chatsController.getAdminChatMessages);
router.post('/admin/:chatId/messages', supportStaffWrite, chatsController.sendAdminChatMessage);
router.patch('/admin/:chatId/status', supportStaffWrite, chatsController.updateTicketStatus);
router.patch('/admin/:chatId/assign', supportStaffWrite, chatsController.assignAndOpenTicket);
router.delete('/admin/:chatId', supportStaffWrite, chatsController.deleteTicketAdmin);

router.get('/:companyName/messages', authenticate, chatsController.getChatMessages);
router.post('/:companyName/messages', authenticate, chatsController.sendMessage);
router.patch('/:companyName/read', authenticate, chatsController.markAsRead);
router.get('/:companyName/appointment', authenticate, chatsController.getAppointment);
router.post('/:companyName/appointment', supportStaffWrite, chatsController.setAppointment);
router.patch('/:companyName/appointment/confirm', authenticate, chatsController.confirmAppointment);
router.patch('/:companyName/appointment/reject', authenticate, chatsController.rejectAppointment);
router.get('/:companyName/appointment/slots', authenticate, chatsController.getAppointmentSlots);
router.post('/:companyName/appointment/choose', authenticate, chatsController.chooseAppointment);

export default router;
