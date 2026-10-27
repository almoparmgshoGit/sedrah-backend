import { Router } from 'express';
import {
  getCategories,
  getProducts,
  getProductById,
  getBanners,
  createOrder,
  getUserOrders,
  getOrderDetails,
} from '../controllers/store.controller';
import { authenticate } from '../middlewares/security.middleware';

const router = Router();

router.get('/categories', getCategories);
router.get('/products', getProducts);
router.get('/products/:id', getProductById);
router.get('/banners', getBanners);

router.post('/orders', authenticate, createOrder);
router.get('/orders', authenticate, getUserOrders);
router.get('/orders/:orderIdentifier', authenticate, getOrderDetails);

export default router;
