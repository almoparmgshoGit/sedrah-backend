import { Router } from 'express';
import { getUserFavorites, addFavorite, removeFavorite } from '../controllers/favorites.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();

router.use(authenticate);

router.get('/', getUserFavorites);
router.post('/', addFavorite);
router.delete('/:id', removeFavorite);

export default router;
