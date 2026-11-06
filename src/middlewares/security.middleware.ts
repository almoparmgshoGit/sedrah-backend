import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { pool } from '../config/db';

// 1. Rate Limiting against Brute Force & DDoS (OWASP API4:2023)
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // Generous limit per IP for smooth dashboard & app operations
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
});

// Routes that send email or create accounts (register, send OTP, company requests)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة، يرجى المحاولة بعد 15 دقيقة' },
});

// Credential checks: only failed attempts count, so users sharing one network are not locked out by each other's logins
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات دخول خاطئة كثيرة، يرجى المحاولة بعد 15 دقيقة' },
});

// Token issuing endpoints that any client can call without credentials
export const sessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة، يرجى المحاولة لاحقاً' },
});

// Booking codes are short, so guessing them is throttled
export const bookingLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة لربط الحجز، يرجى المحاولة بعد 15 دقيقة' },
});

// Each reset request can send an email or run argon2, so it gets a tighter limit than other auth routes
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة، يرجى المحاولة بعد 15 دقيقة' },
});

// Interface for Authenticated Request
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin' | 'super_admin';
  };
}

// Helper to check if a route is in the Guest Allowlist
const isGuestAllowedRoute = (method: string, originalUrl: string): boolean => {
  const pathName = originalUrl.split('?')[0];

  // Visitors browsing without an account still count towards a package's views and shares
  if (method === 'POST') return /^\/api\/packages\/[^/]+\/(view|share)$/.test(pathName);
  if (method !== 'GET') return false;

  const allowedPrefixes = [
    '/api/public/settings',
    '/api/cities',
    '/api/governorates',
    '/api/companies',
    '/api/packages',
    '/api/search',
    '/api/store/categories',
    '/api/store/products',
    '/api/store/banners',
  ];

  if (pathName === '/api/companies/my-profile') return false;

  return allowedPrefixes.some(prefix => pathName === prefix || pathName.startsWith(prefix + '/'));
};

// 2. Authentication Middleware (Verify JWT token securely)
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Access token missing or malformed' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const rawDecoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as any;

    const role = rawDecoded.role;
    const aud = rawDecoded.aud;

    if (role === 'guest' || aud === 'sdra-guest') {
      if (!isGuestAllowedRoute(req.method, req.originalUrl)) {
        res.status(403).json({ error: 'Guest access forbidden for this resource' });
        return;
      }
      req.user = {
        id: rawDecoded.id || 'guest',
        email: 'guest@sdra.tech',
        role: 'guest' as any,
      };
      return next();
    }

    let userId = String(rawDecoded.id);
    const userCheck = await pool.query('SELECT id, status FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      res.status(401).json({ error: 'المستخدم غير موجود أو انتهت صلاحية الجلسة' });
      return;
    }

    const user = userCheck.rows[0];
    if (user.status === 'banned' || user.status === 'inactive') {
      res.status(401).json({ error: 'الحساب محظور أو غير نشط' });
      return;
    }

    req.user = {
      ...rawDecoded,
      id: userId,
    };
    next();
  } catch (err: any) {
    console.error('🔒 [Auth Middleware Verification Error]:', err.message || err);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// 3. Authorization Middleware (RBAC: Role-Based Access Control)
export const authorize = (allowedRoles: string[] = ['admin', 'super_admin', 'support', 'moderator']) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized user context' });
      return;
    }

    const effectiveAllowed = Array.from(new Set(['super_admin', 'admin', 'owner', ...allowedRoles]));
    if (effectiveAllowed.includes(req.user.role)) {
      return next();
    }

    res.status(403).json({ error: 'Forbidden: You do not have permission to access this resource' });
  };
};

// 4. BOLA / IDOR Prevention Middleware / Helper
export const verifyOwnershipOrAdmin = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const targetUserId = req.params.id as string;

  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const isOwner = req.user.id === targetUserId;
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: 'Forbidden: BOLA/IDOR protection triggered. You cannot access another user\'s data.' });
    return;
  }

  next();
};

// 5. Idempotency Middleware for preventing duplicate execution of sensitive operations
import crypto from 'crypto';

// In-memory set to lock concurrent in-flight requests with identical idempotency key (prevent race condition)
const processingKeys = new Set<string>();

export const idempotencyMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const clientKey = req.headers['x-idempotency-key'];
  if (!clientKey || typeof clientKey !== 'string' || clientKey.length > 100) {
    return next();
  }
  // Scoped to the caller, so one user can never replay or block another user's request
  const idempotencyKey = `${req.user?.id || 'anon'}:${clientKey}`;

  // 1. Race condition check: If another identical request is currently executing in-flight, block concurrent duplicate
  if (processingKeys.has(idempotencyKey)) {
    res.status(409).json({ error: 'الطلب قيد المعالجة بالفعل، يرجى الانتظار.' });
    return;
  }

  const userId = req.user?.id || null;
  const requestPayload = JSON.stringify({ body: req.body, query: req.query, params: req.params, method: req.method, url: req.originalUrl });
  const requestHash = crypto.createHash('sha256').update(requestPayload).digest('hex');

  try {
    const existing = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        res.status(400).json({ error: 'Idempotency key reused with different request payload' });
        return;
      }
      res.status(row.response_status).json(row.response_body);
      return;
    }

    // Acquire lock for this key during execution
    processingKeys.add(idempotencyKey);

    const cleanup = () => {
      processingKeys.delete(idempotencyKey);
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);

    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      const status = res.statusCode;
      // Only successful results are replayed; a failed attempt can be retried with the same key
      if (status >= 400) {
        cleanup();
        return originalJson(body);
      }
      pool.query(
        'INSERT INTO idempotency_keys (key, user_id, request_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (key) DO NOTHING',
        [idempotencyKey, userId, requestHash, status, JSON.stringify(body)]
      ).catch(err => console.error('Idempotency save error:', err))
       .finally(cleanup);

      return originalJson(body);
    };

    next();
  } catch (err) {
    processingKeys.delete(idempotencyKey);
    console.error('Idempotency middleware error:', err);
    next();
  }
};
