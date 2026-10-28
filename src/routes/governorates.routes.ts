import { Router } from 'express';
import { getGovernorates, getShippingConfig, updateShippingConfig, updateGovernorateShipping } from '../controllers/governorates.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();
router.get('/', getGovernorates);
router.get('/admin/shipping-config', authenticate, getShippingConfig);
router.patch('/admin/shipping-config', authenticate, updateShippingConfig);
router.patch('/admin/:id/shipping', authenticate, updateGovernorateShipping);

export default router;
