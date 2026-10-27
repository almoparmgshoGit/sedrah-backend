import { Router } from 'express';
import {
  getAllUsers,
  getUserDetails,
  createUserByAdmin,
  updateUserByAdmin,
  banUserByAdmin,
  createCompanyForUser,
  deleteUserByAdmin,
  getAllBookings,
  updateBookingStatusByAdmin,
  updateTripStageByAdmin,
  getBookingStagesByAdmin,
  getAllCompanies,
  getAllCities,
  getAllReviews,
  deleteReviewByAdmin,
  toggleHideReviewByAdmin,
  getAuditLogs,
  getSettings,
  updateSettings,
  testSmtpConnection,
  reviewBookingReceiptByAdmin,
  adminGetCategories,
  adminCreateCategory,
  adminUpdateCategory,
  adminDeleteCategory,
  adminGetProducts,
  adminCreateProduct,
  adminUpdateProduct,
  adminDeleteProduct,
  adminGetBanners,
  adminCreateBanner,
  adminUpdateBanner,
  adminDeleteBanner,
  adminGetOrders,
  adminUpdateOrderStatus,
  getNotificationTemplates,
  createNotificationTemplate,
  updateNotificationTemplate,
  deleteNotificationTemplate,
  resetNotificationTemplates,
} from '../controllers/admin.controller';
import {
  updateCity,
  getCityCompanies,
  createCityCompany,
  linkCompanyToCity
} from '../controllers/cities.controller';
import { createCompanyFull, getCompanyAdminDetails, createCompanyPackage, updateCompany } from '../controllers/companies.controller';
import { updatePackageByAdmin, deletePackageByAdmin, updatePackageStatusByAdmin } from '../controllers/packages.controller';
import { sendNotificationByAdmin, getAllAdminNotifications, getPushTokenStats, deleteNotification } from '../controllers/notifications.controller';
import { authenticate, authorize, idempotencyMiddleware } from '../middlewares/security.middleware';
import { requireModulePermission } from '../middlewares/permission.middleware';

const router = Router();

// All routes require authentication and admin/staff role
router.use(authenticate, authorize(['admin', 'super_admin', 'support', 'moderator']));

router.get('/users', requireModulePermission('users'), getAllUsers);
router.get('/users/:id', requireModulePermission('users'), getUserDetails);
router.post('/users', idempotencyMiddleware, requireModulePermission('users'), createUserByAdmin);
router.put('/users/:id', idempotencyMiddleware, requireModulePermission('users'), updateUserByAdmin);
router.put('/users/:id/ban', idempotencyMiddleware, requireModulePermission('users'), banUserByAdmin);
router.post('/users/:id/company', idempotencyMiddleware, requireModulePermission('companies'), createCompanyForUser);
router.delete('/users/:id', idempotencyMiddleware, requireModulePermission('users'), deleteUserByAdmin);

router.get('/bookings', requireModulePermission('bookings'), getAllBookings);
router.patch('/bookings/:id/status', idempotencyMiddleware, requireModulePermission('bookings'), updateBookingStatusByAdmin);
router.patch('/bookings/:id/receipt-review', idempotencyMiddleware, requireModulePermission('bookings'), reviewBookingReceiptByAdmin);
router.patch('/bookings/:id/stages/:stageId', idempotencyMiddleware, requireModulePermission('bookings'), updateTripStageByAdmin);
router.get('/bookings/:id/stages', requireModulePermission('bookings'), getBookingStagesByAdmin);

router.get('/companies', requireModulePermission('companies'), getAllCompanies);
router.post('/companies', idempotencyMiddleware, requireModulePermission('companies'), createCompanyFull);
router.put('/companies/:id', idempotencyMiddleware, requireModulePermission('companies'), updateCompany);
router.get('/companies/:id/details', requireModulePermission('companies'), getCompanyAdminDetails);
router.post('/companies/:id/packages', idempotencyMiddleware, requireModulePermission('packages'), createCompanyPackage);
router.put('/packages/:id', idempotencyMiddleware, requireModulePermission('packages'), updatePackageByAdmin);
router.delete('/packages/:id', idempotencyMiddleware, requireModulePermission('packages'), deletePackageByAdmin);
router.patch('/packages/:id/status', idempotencyMiddleware, requireModulePermission('packages'), updatePackageStatusByAdmin);

router.get('/cities', getAllCities);
router.put('/cities/:id', idempotencyMiddleware, requireModulePermission('companies'), updateCity);
router.get('/cities/:id/companies', requireModulePermission('companies'), getCityCompanies);
router.post('/cities/:id/companies', idempotencyMiddleware, requireModulePermission('companies'), createCityCompany);
router.post('/cities/:id/link-company', idempotencyMiddleware, requireModulePermission('companies'), linkCompanyToCity);

router.get('/reviews', requireModulePermission('reviews'), getAllReviews);
router.delete('/reviews/:id', idempotencyMiddleware, requireModulePermission('reviews'), deleteReviewByAdmin);
router.patch('/reviews/:id/toggle-hide', idempotencyMiddleware, requireModulePermission('reviews'), toggleHideReviewByAdmin);

router.get('/notifications', requireModulePermission('notifications'), getAllAdminNotifications);
router.get('/notifications/push-stats', requireModulePermission('notifications'), getPushTokenStats);
router.post('/notifications', idempotencyMiddleware, requireModulePermission('notifications'), sendNotificationByAdmin);
router.delete('/notifications/:id', idempotencyMiddleware, requireModulePermission('notifications'), deleteNotification);

// Notification Templates Routes
router.get('/notification-templates', requireModulePermission('notifications'), getNotificationTemplates);
router.post('/notification-templates', idempotencyMiddleware, requireModulePermission('notifications'), createNotificationTemplate);
router.put('/notification-templates/:id', idempotencyMiddleware, requireModulePermission('notifications'), updateNotificationTemplate);
router.delete('/notification-templates/:id', idempotencyMiddleware, requireModulePermission('notifications'), deleteNotificationTemplate);
router.post('/notification-templates/reset', idempotencyMiddleware, requireModulePermission('notifications'), resetNotificationTemplates);

router.get('/audit-logs', requireModulePermission('audit_logs'), getAuditLogs);

router.get('/settings', requireModulePermission('settings'), getSettings);
router.put('/settings', idempotencyMiddleware, requireModulePermission('settings'), updateSettings);
router.post('/settings/test-smtp', idempotencyMiddleware, requireModulePermission('settings'), testSmtpConnection);

// Store Management Routes
router.get('/store/categories', adminGetCategories);
router.post('/store/categories', idempotencyMiddleware, adminCreateCategory);
router.put('/store/categories/:id', idempotencyMiddleware, adminUpdateCategory);
router.delete('/store/categories/:id', idempotencyMiddleware, adminDeleteCategory);

router.get('/store/products', adminGetProducts);
router.post('/store/products', idempotencyMiddleware, adminCreateProduct);
router.put('/store/products/:id', idempotencyMiddleware, adminUpdateProduct);
router.delete('/store/products/:id', idempotencyMiddleware, adminDeleteProduct);

router.get('/store/banners', adminGetBanners);
router.post('/store/banners', idempotencyMiddleware, adminCreateBanner);
router.put('/store/banners/:id', idempotencyMiddleware, adminUpdateBanner);
router.delete('/store/banners/:id', idempotencyMiddleware, adminDeleteBanner);

router.get('/store/orders', adminGetOrders);
router.patch('/store/orders/:id/status', idempotencyMiddleware, adminUpdateOrderStatus);

export default router;
