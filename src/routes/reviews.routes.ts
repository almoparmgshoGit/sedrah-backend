import { Router } from 'express';
import { authenticate } from '../middlewares/security.middleware';
import { getUserReviews } from '../controllers/reviews.controller';

const router = Router();

router.get('/my', authenticate, getUserReviews);

export default router;
