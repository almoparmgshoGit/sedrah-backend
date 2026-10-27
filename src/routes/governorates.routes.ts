import { Router } from 'express';
import { getGovernorates } from '../controllers/governorates.controller';

const router = Router();
router.get('/', getGovernorates);

export default router;
