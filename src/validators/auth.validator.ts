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

export const companyRequestSchema = z.object({
  body: z.object({
    companyName: z.string().trim().min(2).max(255),
    governorate: z.string().trim().min(1).max(255),
    city: z.string().trim().min(1).max(255),
    phone: z.string().trim().min(5).max(50),
    email: z.string().trim().email('Invalid email address format').max(255),
    address: z.string().trim().min(1).max(1000),
    licenseNumber: z.string().trim().min(1).max(100),
    taxNumber: z.string().trim().max(100).nullish(),
    password: z.string().min(8, 'Password must be at least 8 characters long').max(128),
    licenseDoc: z.string().nullish(),
    logo: z.string().nullish(),
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
