import { Router } from 'express';
import { createBooking, getUserBookings, getBookingById, updateBookingReceipt, linkBookingByReference, getBookingStages } from '../controllers/bookings.controller';
import { authenticate, idempotencyMiddleware } from '../middlewares/security.middleware';

const router = Router();

router.use(authenticate);

router.post('/link', idempotencyMiddleware, linkBookingByReference);
router.post('/', idempotencyMiddleware, createBooking);
router.get('/', getUserBookings);
router.get('/:id', getBookingById);
router.post('/:id/receipt', idempotencyMiddleware, updateBookingReceipt);
router.get('/:id/stages', getBookingStages);

export default router;
