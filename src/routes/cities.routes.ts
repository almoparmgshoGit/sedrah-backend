import { Router } from 'express';
import { getCities, getCityById , subscribeToCity } from '../controllers/cities.controller';

const router = Router();

router.get('/', getCities);
router.get('/:id', getCityById);
router.post('/:id/notify-me', subscribeToCity);

export default router;
