import { Router } from 'express';
import { getGovernorates, updateGovernorateShipping } from '../controllers/governorates.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();
router.get('/', getGovernorates);
router.patch('/admin/:id/shipping', authenticate, updateGovernorateShipping);

export default router;
