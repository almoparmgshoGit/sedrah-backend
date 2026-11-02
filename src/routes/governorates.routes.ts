import { Router } from 'express';
import { getGovernorates, getShippingConfig, updateShippingConfig, updateGovernorateShipping } from '../controllers/governorates.controller';
import { authenticate, authorize } from '../middlewares/security.middleware';
import { requireModulePermission } from '../middlewares/permission.middleware';

const router = Router();
router.get('/', getGovernorates);
router.get('/admin/shipping-config', authenticate, authorize(), requireModulePermission('store'), getShippingConfig);
router.patch('/admin/shipping-config', authenticate, authorize(), requireModulePermission('store'), updateShippingConfig);
router.patch('/admin/:id/shipping', authenticate, authorize(), requireModulePermission('store'), updateGovernorateShipping);

export default router;
