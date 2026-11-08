import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { pool } from './config/db';
import { globalLimiter, authLimiter, loginLimiter, sessionLimiter, passwordResetLimiter, authenticate, verifyOwnershipOrAdmin, AuthRequest } from './middlewares/security.middleware';
import { registerSchema, loginSchema, updateProfileSchema, sendOtpSchema, verifyOtpSchema, forgotPasswordSchema, resetPasswordSchema, companyRequestSchema, companyRequestDocumentSchema } from './validators/auth.validator';
import { createCompanyRequest, getMyCompanyRequest, resubmitMyCompanyRequestDocument } from './controllers/companyRequests.controller';
import { register, login, sendOtp, verifyOtp, forgotPassword, resetPassword, getUserProfile, updateUserProfile, getCurrentUser, updateMyProfile, getProfileStatus, googleLogin, deleteMyAccount, generateGuestToken, handleRefreshToken, logoutUser } from './controllers/auth.controller';
import { getPublicSettings } from './controllers/admin.controller';
import citiesRouter from './routes/cities.routes';
import companyWorkspaceRouter from './routes/company.routes';
import governoratesRouter from './routes/governorates.routes';
import companiesRouter from './routes/companies.routes';
import searchRouter from './routes/search.routes';
import packagesRouter from './routes/packages.routes';
import bookingsRouter from './routes/bookings.routes';
import documentsRouter from './routes/documents.routes';
import favoritesRouter from './routes/favorites.routes';
import notificationsRouter from './routes/notifications.routes';
import reviewsRouter from './routes/reviews.routes';
import chatsRouter from './routes/chats.routes';
import uploadRouter from './routes/upload.routes';
import adminRouter from './routes/admin.routes';
import storeRouter from './routes/store.routes';
import couponsRouter from './routes/coupons.routes';
import permissionsRouter from './routes/permissions.routes';
import path from 'path';
import { AnyZodObject } from 'zod';
import { UPLOAD_CATEGORIES, SENSITIVE_UPLOAD_CATEGORIES, canAccessUpload } from './utils/uploadAccess';
import { startAppointmentScheduler } from './utils/appointmentLifecycle';

// Initialize Pino logger for secure, structured auditing
const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  transport: env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
});

const app = express();
app.disable('x-powered-by');

// Behind nginx every request arrives from the proxy; without this all users would share one rate-limit bucket
const parseTrustProxy = (value: string): boolean | number | string => {
  const clean = value.trim();
  if (clean === 'true') return true;
  if (clean === 'false') return false;
  if (/^\d+$/.test(clean)) return parseInt(clean, 10);
  return clean;
};
app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

// Browser origins allowed to call the API. Native apps send no Origin header and are always allowed.
const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
const allowAnyOrigin = allowedOrigins.length === 0 || allowedOrigins.includes('*');
if (allowAnyOrigin && env.NODE_ENV === 'production') {
  logger.warn('CORS_ORIGIN is "*": any website can call the API. Set it to the admin and company panel origins.');
}
const isOriginAllowed = (origin: string | undefined): boolean =>
  !origin || allowAnyOrigin || allowedOrigins.includes(origin.replace(/\/+$/, ''));

// Deep Link Verification Endpoints (Android App Links & iOS Universal Links)
app.get('/.well-known/assetlinks.json', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.sdra.app',
        sha256_cert_fingerprints: [
          'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'
        ]
      }
    }
  ]);
});

app.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'], (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    applinks: {
      apps: [],
      details: [
        {
          appID: 'TEAMID.com.sdra.app',
          paths: ['/company/*', '/package/*', '/product/*']
        }
      ]
    }
  });
});

// Non-app browser fallback redirect page for shared links
const SHARE_PATH = /^\/(company|package|product)\/[A-Za-z0-9_.~%-]{1,200}\/?$/;
app.get(['/company/*', '/package/*', '/product/*'], (req: Request, res: Response) => {
  const reqPath = req.path;
  // The path is written into HTML and a script, so only plain id characters are accepted
  if (!SHARE_PATH.test(reqPath)) {
    res.status(404).json({ error: 'Not Found' });
    return;
  }
  const deepLinkUrl = `sdra:/${reqPath}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>تطبيق سدرة | Sedrah App</title>
      <script>
        // Attempt automatic redirect to installed app via scheme
        window.location.href = "${deepLinkUrl}";
      </script>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #173D35; color: #fff; text-align: center; padding: 40px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
        .card { background: #ffffff; color: #202923; padding: 32px 24px; border-radius: 24px; max-width: 400px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
        h1 { font-size: 22px; margin-bottom: 12px; color: #173D35; font-weight: bold; }
        p { font-size: 14px; color: #4B5563; margin-bottom: 24px; line-height: 1.6; }
        .btn-primary { display: block; background: #173D35; color: #ffffff; text-decoration: none; padding: 14px 20px; border-radius: 14px; font-weight: bold; font-size: 15px; margin-bottom: 12px; }
        .btn-secondary { display: block; background: #C8A96A; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 14px; font-weight: bold; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>منصة وتطبيق سدرة</h1>
        <p>لعرض تفاصيل هذا المحتوى والتواصل المباشر، اضغط أدناه لفتح التطبيق أو تحميلة على هاتفك.</p>
        <a href="${deepLinkUrl}" class="btn-primary">فتح في تطبيق سدرة 📲</a>
        <a href="https://play.google.com/store/apps/details?id=com.sdra.app" class="btn-secondary">تحميل التطبيق من المتجر</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/', (req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e6,
});

const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];

io.use((socket, next) => {
  try {
    const decoded = jwt.verify(String(socket.handshake.auth?.token || ''), env.JWT_SECRET, { algorithms: ['HS256'] }) as any;
    if (decoded.role === 'guest' || decoded.aud === 'sdra-guest') return next(new Error('Unauthorized'));
    socket.data.user = decoded;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  const isStaff = STAFF_ROLES.includes(user.role);
  if (isStaff) {
    socket.join('staff');
    // Admin alerts are sent per admin, since each one only receives the modules it is allowed to open
    socket.join(`admin_${user.id}`);
  }
  logger.info(`Socket connected: ${socket.id}`);

  socket.on('join_room', async (room: string) => {
    try {
      if (typeof room !== 'string') return;
      if (!isStaff) {
        // Customers may only join the rooms of their own chats, and a company owner those of its company's chats
        if (!room.startsWith('chat_')) return;
        const owned = await pool.query(
          `SELECT 1 FROM chats c
           WHERE c.id = $1 AND c.ticket_number IS NULL AND (
             c.user_id = $2
             OR EXISTS (
               SELECT 1 FROM companies co
               WHERE (co.id = c.company_id OR co.name = c.company_name)
                 AND (co.user_id = $2 OR EXISTS (
                   SELECT 1 FROM company_members cm
                   JOIN company_roles r ON cm.role_id = r.id
                   WHERE cm.company_id = co.id AND cm.user_id = $2 AND cm.status = 'active'
                     AND (r.permissions LIKE '%"chats.view"%' OR r.permissions LIKE '%"chats.reply"%')
                 ))
             )
           )
           UNION
           SELECT 1 FROM chats c WHERE c.id = $1 AND c.user_id = $2
           UNION
           SELECT 1 FROM chats c JOIN companies co ON co.id = c.company_id
           WHERE c.id = $1 AND c.ticket_number IS NOT NULL AND c.department = 'companies'
             AND (co.user_id = $2 OR EXISTS (
               SELECT 1 FROM company_members cm JOIN company_roles r ON cm.role_id = r.id
               WHERE cm.company_id = co.id AND cm.user_id = $2 AND cm.status = 'active' AND r.permissions LIKE '%"support.tickets"%'
             ))`,
          [room.slice(5), String(user.id)]
        );
        if (owned.rows.length === 0) return;
      }
      socket.join(room);
    } catch (err) {
      logger.error(err);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`);
  });
});

export { io };

// 1. Security HTTP Headers (Helmet)
// The API serves JSON; the only HTML it serves is the share-link page with its small inline redirect script
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// 2. CORS: only the configured browser origins (see CORS_ORIGIN). Auth uses bearer tokens, never cookies.
app.use(cors({
  origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'x-idempotency-key'],
  credentials: !allowAnyOrigin,
}));

// 3. Request body size limits. Large bodies are accepted only where files are sent as base64.
app.use('/api/upload', express.json({ limit: '20mb' }));
app.use('/api/company-requests', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 4. Pino HTTP Request Logger Middleware
app.use(pinoHttp({
  logger,
  serializers: {
    req: (req: any) => ({ ...req, url: String(req.url || '').replace(/([?&]token=)[^&]*/, '$1[REDACTED]') }),
  },
}));

// 5. Global Rate Limiter
app.use('/api/', globalLimiter);

// Secure Uploads Access Middleware for sensitive folders (receipts, chats, profiles, documents)
const baseUploadDir = path.join(__dirname, '../uploads');
const INLINE_UPLOAD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.svg', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

app.get('/uploads/:category/:filename', async (req: Request, res: Response): Promise<void> => {
  try {
    const category = String(req.params.category || '');
    const filename = String(req.params.filename || '');

    // Exact folder match: blocks "..", and case variants on case-insensitive file systems
    if (!UPLOAD_CATEGORIES.includes(category) || /[/\\:]/.test(filename) || filename.startsWith('.')) {
      res.status(404).json({ error: 'الملف غير موجود' });
      return;
    }

    if (SENSITIVE_UPLOAD_CATEGORIES.includes(category)) {
      const authHeader = req.headers.authorization;
      let token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token && authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }

      let isAuthorized = false;
      if (token) {
        try {
          const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as any;
          if (decoded.role !== 'guest' && decoded.aud !== 'sdra-guest') {
            isAuthorized = await canAccessUpload(String(decoded.id), filename);
          }
        } catch (e) {
          isAuthorized = false;
        }
      }

      if (!isAuthorized) {
        res.status(403).json({ error: 'غير مصرح بالوصول إلى هذا المستند الحساس. يتطلب تسجيل دخول صالح وتوكن مصادقة.' });
        return;
      }
    }

    const filePath = path.join(baseUploadDir, category, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'الملف غير موجود' });
      return;
    }

    // Uploaded content is never allowed to run scripts on the API origin
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.pdf') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; object-src 'self'");
    } else {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      if (!INLINE_UPLOAD_EXTENSIONS.includes(ext)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
      }
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(filePath);
  } catch (error) {
    logger.error(error);
    res.status(500).json({ error: 'تعذر جلب الملف' });
  }
});

// Zod Validation Middleware Factory
const validate = (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });
    next();
  } catch (error: any) {
    res.status(400).json({
      error: 'Validation failed',
      details: error.errors?.map((e: any) => ({ path: e.path.join('.'), message: e.message })) || error.message,
    });
  }
};

// --- API ROUTES ---

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Public Settings Route
app.get('/api/public/settings', getPublicSettings);

// Public Session Creation Routes (No Token Required)
app.post('/api/auth/register', authLimiter, validate(registerSchema), register);
app.post('/api/auth/send-otp', authLimiter, validate(sendOtpSchema), sendOtp);
app.post('/api/auth/verify-otp', loginLimiter, validate(verifyOtpSchema), verifyOtp);
app.post('/api/auth/login', loginLimiter, validate(loginSchema), login);
app.post('/api/auth/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), forgotPassword);
app.post('/api/auth/reset-password', passwordResetLimiter, validate(resetPasswordSchema), resetPassword);
app.post('/api/auth/google', loginLimiter, googleLogin);
app.post('/api/auth/guest-token', sessionLimiter, generateGuestToken);
app.post('/api/auth/refresh-token', sessionLimiter, handleRefreshToken);
// Logout is proven by the refresh token itself, so it works even after the access token has expired
app.post('/api/auth/logout', sessionLimiter, logoutUser);

// Default Deny: All other /api/* routes require a valid JWT token (Guest, Customer, Company, or Admin)
app.use('/api', authenticate);

// Company registration: guests are refused by authenticate, since these paths are not on its allowlist
app.post('/api/company-requests', authLimiter, validate(companyRequestSchema), createCompanyRequest);
app.get('/api/company-requests/my', getMyCompanyRequest);
app.post('/api/company-requests/my/document', authLimiter, validate(companyRequestDocumentSchema), resubmitMyCompanyRequestDocument);

app.get('/api/auth/me', getCurrentUser);
app.put('/api/auth/profile', updateMyProfile);
app.get('/api/auth/profile-status', getProfileStatus);
app.delete('/api/auth/account', deleteMyAccount);

// Cities Routes
app.use('/api/cities', citiesRouter);

// Governorate Routes
app.use('/api/governorates', governoratesRouter);

// Permission Groups Routes
app.use('/api/admin/permission-groups', permissionsRouter);

// Companies Routes
app.use('/api/companies', companiesRouter);

// The signed-in company owner's own workspace
app.use('/api/company', companyWorkspaceRouter);

// Search & Filter Routes
app.use('/api/search', searchRouter);

// Packages Routes
app.use('/api/packages', packagesRouter);

// Bookings Routes
app.use('/api/bookings', bookingsRouter);

// Documents Routes
app.use('/api/documents', documentsRouter);

// Favorites Routes
app.use('/api/favorites', favoritesRouter);

// Notifications Routes
app.use('/api/notifications', notificationsRouter);

// Reviews Routes
app.use('/api/reviews', reviewsRouter);

// Chats Routes
app.use('/api/chats', chatsRouter);

// Upload Routes
app.use('/api/upload', uploadRouter);

// Store Routes
app.use('/api/store', storeRouter);

// Coupons Routes
app.use('/api/coupons', couponsRouter);

// Admin Routes (Protected + RBAC)
app.use('/api/admin', adminRouter);

// User Profile Route (Protected + RBAC + BOLA/IDOR protection)
app.get(
  '/api/users/:id',
  authenticate,
  verifyOwnershipOrAdmin,
  getUserProfile
);

app.put(
  '/api/users/:id',
  authenticate,
  verifyOwnershipOrAdmin,
  updateUserProfile
);

// 6. Global Secure Error Handler (Preventing stack trace leakage in production)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'حجم البيانات المرسلة أكبر من المسموح' });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'صيغة البيانات المرسلة غير صالحة' });
    return;
  }
  logger.error(err);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    error: env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
  });
});

// Start Server
server.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`🚀 Secure Sdra Backend running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  // Closes appointments the customer did not attend once their day ends, and sends day-of reminders
  startAppointmentScheduler();
});

export default app;
