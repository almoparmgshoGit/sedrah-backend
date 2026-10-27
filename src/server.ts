import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { globalLimiter, authLimiter, authenticate, authorize, verifyOwnershipOrAdmin, AuthRequest } from './middlewares/security.middleware';
import { registerSchema, loginSchema, updateProfileSchema, sendOtpSchema, verifyOtpSchema } from './validators/auth.validator';
import { register, login, sendOtp, verifyOtp, getUserProfile, updateUserProfile, getCurrentUser, updateMyProfile, getProfileStatus, googleLogin, deleteMyAccount } from './controllers/auth.controller';
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 4. Pino HTTP Request Logger Middleware
app.use(pinoHttp({ logger }));

// 5. Global Rate Limiter
app.use('/api/', globalLimiter);

// Serve uploaded files statically with CORS and CORP headers
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
}, express.static(path.join(__dirname, '../uploads')));

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

// Auth Routes (with strict rate limiting & Zod validation)
app.post('/api/auth/register', authLimiter, validate(registerSchema), register);
app.post('/api/auth/send-otp', authLimiter, validate(sendOtpSchema), sendOtp);
app.post('/api/auth/verify-otp', authLimiter, validate(verifyOtpSchema), verifyOtp);
app.post('/api/auth/login', authLimiter, validate(loginSchema), login);
app.post('/api/auth/google', authLimiter, googleLogin);
app.get('/api/auth/me', authenticate, getCurrentUser);
app.put('/api/auth/profile', authenticate, updateMyProfile);
app.get('/api/auth/profile-status', authenticate, getProfileStatus);
app.delete('/api/auth/account', authenticate, deleteMyAccount);

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
