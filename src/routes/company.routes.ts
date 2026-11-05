import { Router, Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';
import { authLimiter } from '../middlewares/security.middleware';
import * as company from '../controllers/company.controller';
import * as schemas from '../validators/company.validator';

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

router.get('/dashboard', company.getCompanyDashboard as any);

router.get('/profile', company.getCompanyProfile as any);
router.put('/profile', authLimiter, body(schemas.companyProfileSchema), company.updateCompanyProfile as any);

router.get('/packages', company.getCompanyPackagesList as any);
router.post('/packages', authLimiter, body(schemas.companyPackageSchema), company.createCompanyOwnPackage as any);
router.get('/packages/:id', company.getCompanyPackageDetails as any);
router.put('/packages/:id', authLimiter, body(schemas.companyPackageSchema), company.updateCompanyOwnPackage as any);
router.patch('/packages/:id/status', body(schemas.packageStatusSchema), company.updateCompanyPackageStatus as any);
router.delete('/packages/:id', company.deleteCompanyOwnPackage as any);

router.get('/orders', company.getCompanyOrders as any);
router.get('/orders/:id', company.requireCompanyBooking as any, company.getCompanyOrderDetails as any);
router.post('/orders/:id/accept', company.requireCompanyBooking as any, company.acceptCompanyOrder as any);
router.post('/orders/:id/reject', body(schemas.rejectOrderSchema), company.requireCompanyBooking as any, company.rejectCompanyOrder as any);
router.post('/orders/:id/receipt', body(schemas.reviewReceiptSchema), company.requireCompanyBooking as any, company.reviewCompanyReceipt as any);
router.post('/orders/:id/stages/:stageId/complete', body(schemas.updateStageSchema), company.requireCompanyBooking as any, company.completeCompanyStage as any);

router.get('/clients', company.getCompanyClients as any);
router.get('/clients/:clientId', company.getCompanyClientDetails as any);
router.put('/clients/:clientId/note', body(schemas.clientNoteSchema), company.saveCompanyClientNote as any);

router.get('/chats', company.getCompanyChats as any);
router.post('/chats', body(schemas.startChatSchema), company.startCompanyChat as any);
router.get('/chats/:chatId/messages', company.getCompanyChatMessages as any);
router.post('/chats/:chatId/messages', body(schemas.chatMessageSchema), company.sendCompanyChatMessage as any);

router.get('/appointments', company.getCompanyAppointments as any);
router.post('/appointments', body(schemas.appointmentSchema), company.createCompanyAppointment as any);
router.put('/appointments/:id', body(schemas.rescheduleAppointmentSchema), company.rescheduleCompanyAppointment as any);
router.post('/appointments/:id/cancel', body(schemas.cancelAppointmentSchema), company.cancelCompanyAppointment as any);
router.post('/appointments/:id/attended', company.markCompanyAppointmentAttended as any);

export default router;
