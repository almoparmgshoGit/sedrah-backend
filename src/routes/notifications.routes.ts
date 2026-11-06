import { Router } from 'express';
import { authenticate } from '../middlewares/security.middleware';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  registerPushToken,
} from '../controllers/notifications.controller';

const router = Router();

// إشعارات المستخدم
router.get('/', authenticate, getUserNotifications);
router.patch('/read-all', authenticate, markAllNotificationsAsRead);
router.patch('/:id/read', authenticate, markNotificationAsRead);

// تسجيل Push Token (يمكن أن يُستدعى بدون مصادقة عند التسجيل الأول)
router.post('/tokens', registerPushToken);

export default router;
