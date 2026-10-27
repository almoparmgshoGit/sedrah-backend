import { Router } from 'express';
import { chatsController } from '../controllers/chats.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();

router.get('/', authenticate, chatsController.getUserChats);
router.post('/tickets', authenticate, chatsController.createSupportTicket);
router.get('/tickets/user', authenticate, chatsController.getUserSupportTickets);
router.patch('/tickets/:chatId/close', authenticate, chatsController.requestCloseTicket);
router.post('/tickets/:chatId/remind', authenticate, chatsController.sendTicketReminder);

router.get('/admin/all', authenticate, chatsController.getAdminChats);
router.post('/admin/initiate', authenticate, chatsController.createAdminInitiatedChat);
router.get('/admin/:chatId/messages', authenticate, chatsController.getAdminChatMessages);
router.post('/admin/:chatId/messages', authenticate, chatsController.sendAdminChatMessage);
router.patch('/admin/:chatId/status', authenticate, chatsController.updateTicketStatus);
router.patch('/admin/:chatId/assign', authenticate, chatsController.assignAndOpenTicket);
router.delete('/admin/:chatId', authenticate, chatsController.deleteTicketAdmin);

router.get('/:companyName/messages', authenticate, chatsController.getChatMessages);
router.post('/:companyName/messages', authenticate, chatsController.sendMessage);
router.patch('/:companyName/read', authenticate, chatsController.markAsRead);
router.get('/:companyName/appointment', authenticate, chatsController.getAppointment);
router.post('/:companyName/appointment', authenticate, chatsController.setAppointment);
router.patch('/:companyName/appointment/confirm', authenticate, chatsController.confirmAppointment);
router.patch('/:companyName/appointment/reject', authenticate, chatsController.rejectAppointment);

export default router;
