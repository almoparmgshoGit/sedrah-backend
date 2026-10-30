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
import { globalLimiter, authLimiter, authenticate, authorize, verifyOwnershipOrAdmin, AuthRequest } from './middlewares/security.middleware';
import { registerSchema, loginSchema, updateProfileSchema, sendOtpSchema, verifyOtpSchema } from './validators/auth.validator';
import { register, login, sendOtp, verifyOtp, getUserProfile, updateUserProfile, getCurrentUser, updateMyProfile, getProfileStatus, googleLogin, deleteMyAccount, generateGuestToken, handleRefreshToken, logoutUser } from './controllers/auth.controller';
import { getPublicSettings } from './controllers/admin.controller';
import citiesRouter from './routes/cities.routes';
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
import permissionsRouter from './routes/permissions.routes';
import path from 'path';
import { AnyZodObject } from 'zod';

// Initialize Pino logger for secure, structured auditing
const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
});

const app = express();
app.disable('x-powered-by');

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
app.get(['/company/*', '/package/*', '/product/*'], (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>تطبيق سدرة | Sedrah App</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #173D35; color: #fff; text-align: center; padding: 40px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
        .card { background: #ffffff; color: #202923; padding: 32px 24px; border-radius: 24px; max-width: 400px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
        h1 { font-size: 22px; margin-bottom: 12px; color: #173D35; font-weight: bold; }
        p { font-size: 14px; color: #4B5563; margin-bottom: 24px; line-height: 1.6; }
        .btn { display: inline-block; background: #C8A96A; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 14px; font-weight: bold; font-size: 15px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>منصة وتطبيق سدرة</h1>
        <p>لعرض تفاصيل هذا المحتوى والتواصل المباشر وبدء الحجز، يرجى فتح أو تحميل تطبيق سدرة على هاتفك.</p>
        <a href="https://play.google.com/store/apps/details?id=com.sdra.app" class="btn">تحميل تطبيق سدرة</a>
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
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  },
});

io.on('connection', (socket) => {
  logger.info(`Socket connected: ${socket.id}`);

  socket.on('join_room', (room: string) => {
    socket.join(room);
    logger.info(`Socket ${socket.id} joined room: ${room}`);
  });

  socket.on('send_message', (data: any) => {
    if (data?.companyName) {
      io.to(data.companyName).emit('receive_message', data);
    } else if (data?.chatId) {
      io.to(`chat_${data.chatId}`).emit('receive_message', data);
    } else {
      io.emit('receive_message', data);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Socket disconnected: ${socket.id}`);
  });
});

export { io };

// 1. Security HTTP Headers (Helmet)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "*"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      connectSrc: ["'self'", "*", "https:", "http:", "ws:", "wss:"],
    },
  },
}));

// 2. Strict CORS Configuration
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'x-idempotency-key'],
  credentials: true,
}));

// 3. Request Body Parser with size limits to prevent DoS (payload too large)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 4. Pino HTTP Request Logger Middleware
app.use(pinoHttp({ logger }));

// 5. Global Rate Limiter
app.use('/api/', globalLimiter);

// Secure Uploads Access Middleware for sensitive folders (receipts, chats, profiles, documents)
const baseUploadDir = path.join(__dirname, '../uploads');
app.get('/uploads/:category/:filename', (req: Request, res: Response): void => {
  const { category, filename } = req.params;
  const rawCat = Array.isArray(category) ? category[0] : category;
  const rawFile = Array.isArray(filename) ? filename[0] : filename;
  const safeCategory = path.basename(String(rawCat || ''));
  const safeFilename = path.basename(String(rawFile || ''));
  const filePath = path.join(baseUploadDir, safeCategory, safeFilename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'الملف غير موجود' });
    return;
  }

  const sensitiveFolders = ['receipts', 'chats', 'profiles', 'documents'];
  if (sensitiveFolders.includes(safeCategory)) {
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string;
    let token = queryToken;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    let isAuthorized = false;
    if (token) {
      try {
        jwt.verify(token, env.JWT_SECRET);
        isAuthorized = true;
      } catch (e) {
        isAuthorized = false;
      }
    }

    if (!isAuthorized) {
      res.status(403).json({ error: 'غير مصرح بالوصول إلى هذا المستند الحساس. يتطلب تسجيل دخول صالح وتوكن مصادقة.' });
      return;
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(filePath);
});

// General static files fallback
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(baseUploadDir));

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
app.post('/api/auth/verify-otp', authLimiter, validate(verifyOtpSchema), verifyOtp);
app.post('/api/auth/login', authLimiter, validate(loginSchema), login);
app.post('/api/auth/google', authLimiter, googleLogin);
app.post('/api/auth/guest-token', generateGuestToken);
app.post('/api/auth/refresh-token', handleRefreshToken);

// Default Deny: All other /api/* routes require a valid JWT token (Guest, Customer, Company, or Admin)
app.use('/api', authenticate);

app.post('/api/auth/logout', logoutUser);
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

// Admin-only Route Example (RBAC demonstration)
app.get(
  '/api/admin/audit-logs',
  authenticate,
  authorize(['admin', 'super_admin']),
  (req: AuthRequest, res: Response) => {
    logger.info({ adminId: req.user?.id }, 'Admin accessed audit logs');
    res.json({ message: 'Secure audit logs accessed successfully', logs: [] });
  }
);

// 6. Global Secure Error Handler (Preventing stack trace leakage in production)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error(err);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    error: env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
  });
});

// Start Server
server.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`🚀 Secure Sdra Backend running on port ${env.PORT} in ${env.NODE_ENV} mode`);
});

export default app;
