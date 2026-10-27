import { Router } from 'express';
import { getBookingDocuments } from '../controllers/documents.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();

router.use(authenticate);

router.get('/:bookingId', getBookingDocuments);

export default router;
