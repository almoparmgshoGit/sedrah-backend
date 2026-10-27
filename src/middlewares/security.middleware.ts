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

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Generous limit on auth attempts in development
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

// Interface for Authenticated Request
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin' | 'super_admin';
  };
}

// 2. Authentication Middleware (Verify JWT token securely)
export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Access token missing or malformed' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const rawDecoded = jwt.verify(token, env.JWT_SECRET) as { id: any; email: string; role: 'user' | 'admin' | 'super_admin' };
    let userId = String(rawDecoded.id);

    try {
      const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0 && rawDecoded.email) {
        const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1', [rawDecoded.email]);
        if (emailCheck.rows.length > 0) {
          userId = emailCheck.rows[0].id;
        } else {
          await pool.query(
            'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING',
            [userId, rawDecoded.email.split('@')[0], rawDecoded.email, 'dummyhash', rawDecoded.role || 'user']
          );
        }
      } else if (userCheck.rows.length > 0) {
        userId = userCheck.rows[0].id;
      }
    } catch (dbErr) {
      console.error('Auto-user ensure error:', dbErr);
    }

    const decoded = {
      ...rawDecoded,
      id: userId,
    };
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired token' });
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
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) {
    return next();
  }

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
