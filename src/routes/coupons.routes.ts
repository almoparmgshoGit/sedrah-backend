import { Router } from 'express';
import { getCoupons, createCoupon, updateCoupon, deleteCoupon, validateCoupon } from '../controllers/coupons.controller';
import { authenticateToken, requireModulePermission } from '../middlewares/permission.middleware';

const router = Router();

router.get('/', authenticateToken, requireModulePermission('store'), getCoupons);
router.post('/', authenticateToken, requireModulePermission('store'), createCoupon);
router.put('/:id', authenticateToken, requireModulePermission('store'), updateCoupon);
router.delete('/:id', authenticateToken, requireModulePermission('store'), deleteCoupon);
router.post('/validate', authenticateToken, validateCoupon);

export default router;
