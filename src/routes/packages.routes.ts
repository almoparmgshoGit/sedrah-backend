import { Router } from 'express';
import { getPackages, getPackageById, trackPackageView, trackPackageShare } from '../controllers/packages.controller';

const router = Router();

router.get('/', getPackages);
router.get('/:id', getPackageById);
router.post('/:id/view', trackPackageView);
router.post('/:id/share', trackPackageShare);

export default router;
