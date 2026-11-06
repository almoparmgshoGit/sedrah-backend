import { Router } from 'express';
import { getPackages, getPackageById, getPackageBookingOptions } from '../controllers/packages.controller';

const router = Router();

router.get('/', getPackages);
router.get('/:id', getPackageById);
router.get('/:id/booking-options', getPackageBookingOptions);

export default router;
