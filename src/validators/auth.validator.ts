import { z } from 'zod';

// Strict validation schema for registration (Preventing Mass Assignment by explicitly omitting role/balance/isAdmin)
export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters').max(100),
    email: z.string().email('Invalid email address format'),
    password: z.string().min(6, 'Password must be at least 6 characters long'),
    phone: z.string().optional(),
  }),
});

export const sendOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address format'),
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address format'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
  }),
});

// Strict validation schema for login
export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address format'),
    password: z.string().min(1, 'Password is required'),
  }),
});

// Strict validation schema for user profile update (Preventing Mass Assignment of role or balance)
export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).optional(),
    phone: z.string().optional(),
    // Note: 'role', 'balance', 'isAdmin' are intentionally excluded to prevent Mass Assignment vulnerability!
  }),
});
