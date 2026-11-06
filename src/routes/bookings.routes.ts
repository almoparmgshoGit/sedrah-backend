import { Router } from 'express';
import { createBooking, getUserBookings, getBookingById, updateBookingReceipt, linkBookingByReference, getBookingStages, getBookingTravelers, updateBookingTravelers } from '../controllers/bookings.controller';
import { authenticate, idempotencyMiddleware, bookingLinkLimiter } from '../middlewares/security.middleware';

const router = Router();

router.use(authenticate);

router.post('/link', bookingLinkLimiter, idempotencyMiddleware, linkBookingByReference);
router.post('/', idempotencyMiddleware, createBooking);
router.get('/', getUserBookings);
router.get('/:id', getBookingById);
router.post('/:id/receipt', idempotencyMiddleware, updateBookingReceipt);
router.get('/:id/stages', getBookingStages);
router.get('/:id/travelers', getBookingTravelers);
router.put('/:id/travelers', idempotencyMiddleware, updateBookingTravelers);

export default router;
