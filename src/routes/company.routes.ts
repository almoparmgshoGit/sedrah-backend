import { Router, Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';
import { authLimiter } from '../middlewares/security.middleware';
import * as company from '../controllers/company.controller';
import * as schemas from '../validators/company.validator';
import * as team from '../controllers/companyTeam.controller';
import * as support from '../controllers/companySupport.controller';

const router = Router();

// Replaces the body with the parsed result, so unknown fields and untrimmed text never reach a controller
const body = (schema: ZodTypeAny) => (req: Request, res: Response, next: NextFunction): void => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.errors[0]?.message || 'البيانات غير صالحة';
    res.status(400).json({ error: message });
    return;
  }
  req.body = parsed.data;
  next();
};

router.use(company.requireCompany as any);
router.use(company.redactForMember as any);

// Every route below names the permission it needs; the owner holds all of them
const can = (...permissions: string[]) => company.can(...permissions) as any;
const booking = company.requireCompanyBooking as any;

router.get('/access', company.getCompanyAccess as any);
router.get('/dashboard', company.getCompanyDashboard as any);

router.get('/profile', company.getCompanyProfile as any);
router.put('/profile', authLimiter, can('company.profile', 'company.documents'), body(schemas.companyProfileSchema), company.updateCompanyProfile as any);

router.get('/packages', can('packages.view', 'packages.manage'), company.getCompanyPackagesList as any);
router.post('/packages', authLimiter, can('packages.manage'), body(schemas.companyPackageSchema), company.createCompanyOwnPackage as any);
router.get('/packages/:id', can('packages.view', 'packages.manage'), company.getCompanyPackageDetails as any);
router.put('/packages/:id', authLimiter, can('packages.manage'), body(schemas.companyPackageSchema), company.updateCompanyOwnPackage as any);
router.patch('/packages/:id/status', can('packages.manage'), body(schemas.packageStatusSchema), company.updateCompanyPackageStatus as any);
router.delete('/packages/:id', can('packages.delete'), company.deleteCompanyOwnPackage as any);

router.get('/orders', can('orders.view', 'trips.view'), company.getCompanyOrders as any);
router.get('/orders/:id', can('orders.view', 'trips.view'), booking, company.getCompanyOrderDetails as any);
router.post('/orders/:id/accept', can('orders.manage'), booking, company.acceptCompanyOrder as any);
router.post('/orders/:id/reject', can('orders.manage'), body(schemas.rejectOrderSchema), booking, company.rejectCompanyOrder as any);
router.post('/orders/:id/cancel', can('orders.manage'), body(schemas.cancelOrderSchema), booking, company.cancelCompanyOrder as any);
router.post('/orders/:id/remind-payment', authLimiter, can('orders.manage'), booking, company.remindCompanyOrderPayment as any);
router.post('/orders/:id/stages/:stageId/complete', can('trips.stages'), body(schemas.updateStageSchema), booking, company.saveCompanyStage as any);
router.put('/orders/:id/stages/:stageId', can('trips.stages'), body(schemas.updateStageSchema), booking, company.saveCompanyStage as any);


router.get('/finance', can('finance.view'), company.getCompanyFinance as any);
router.get('/reviews', can('reviews.view', 'reviews.reply'), company.getCompanyReviews as any);
router.put('/reviews/:id/reply', can('reviews.reply'), body(schemas.reviewReplySchema), company.replyCompanyReview as any);

// Scheduling an appointment needs the client list, so appointment managers may read it too
router.get('/clients', can('clients.view', 'appointments.manage'), company.getCompanyClients as any);
router.get('/clients/:clientId', can('clients.view'), company.getCompanyClientDetails as any);
router.put('/clients/:clientId/note', can('clients.notes'), body(schemas.clientNoteSchema), company.saveCompanyClientNote as any);

router.get('/chats', can('chats.view', 'chats.reply'), company.getCompanyChats as any);
router.post('/chats', can('chats.reply'), body(schemas.startChatSchema), company.startCompanyChat as any);
router.get('/chats/:chatId/messages', can('chats.view', 'chats.reply'), company.getCompanyChatMessages as any);
router.post('/chats/:chatId/messages', can('chats.reply'), body(schemas.chatMessageSchema), company.sendCompanyChatMessage as any);

router.get('/appointments', can('appointments.view', 'appointments.manage'), company.getCompanyAppointments as any);
router.post('/appointments', can('appointments.manage'), body(schemas.appointmentSchema), company.createCompanyAppointment as any);
router.put('/appointments/:id', can('appointments.manage'), body(schemas.rescheduleAppointmentSchema), company.rescheduleCompanyAppointment as any);
router.post('/appointments/:id/cancel', can('appointments.manage'), body(schemas.cancelAppointmentSchema), company.cancelCompanyAppointment as any);
router.post('/appointments/:id/attended', can('appointments.manage'), company.markCompanyAppointmentAttended as any);

// ───── Support tickets with the platform ─────
router.get('/support/tickets', can('support.tickets'), support.listCompanyTickets as any);
router.post('/support/tickets', authLimiter, can('support.tickets'), body(schemas.companyTicketSchema), support.createCompanyTicket as any);
router.get('/support/tickets/:id/messages', can('support.tickets'), support.getCompanyTicketMessages as any);
router.post('/support/tickets/:id/messages', can('support.tickets'), body(schemas.ticketMessageSchema), support.sendCompanyTicketMessage as any);
router.patch('/support/tickets/:id/close', can('support.tickets'), support.closeCompanyTicket as any);

// ───── Team ─────
router.get('/team/permissions', can('team.view', 'team.manage', 'team.roles'), team.getPermissionCatalogue as any);
router.get('/team/members', can('team.view', 'team.manage'), team.listMembers as any);
router.post('/team/members', authLimiter, can('team.manage'), body(schemas.addMemberSchema), team.addMember as any);
router.patch('/team/members/:id', can('team.manage'), body(schemas.updateMemberSchema), team.updateMember as any);
router.delete('/team/members/:id', can('team.manage'), team.removeMember as any);
router.post('/team/members/:id/resend-invite', authLimiter, can('team.manage'), team.resendInvite as any);
router.post('/team/leave', team.leaveTeam as any);
router.get('/team/roles', can('team.view', 'team.manage', 'team.roles'), team.listRoles as any);
router.post('/team/roles', can('team.roles'), body(schemas.createRoleSchema), team.createRole as any);
router.put('/team/roles/:id', can('team.roles'), body(schemas.updateRoleSchema), team.updateRole as any);
router.delete('/team/roles/:id', can('team.roles'), team.deleteRole as any);
router.get('/team/activity', can('team.activity'), team.listActivity as any);

export default router;
