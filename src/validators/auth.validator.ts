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

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().trim().email('صيغة البريد الإلكتروني غير صحيحة').max(255),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    email: z.string().trim().email('صيغة البريد الإلكتروني غير صحيحة').max(255),
    code: z.string().regex(/^\d{6}$/, 'رمز التحقق يتكون من 6 أرقام'),
    // The upper limit keeps a huge password from tying up the server in argon2
    newPassword: z.string()
      .min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف')
      .max(128, 'كلمة المرور طويلة جداً')
      .regex(/\p{L}/u, 'كلمة المرور يجب أن تحتوي على حرف واحد على الأقل')
      .regex(/\d/, 'كلمة المرور يجب أن تحتوي على رقم واحد على الأقل'),
  }),
});

// 5 MB of image data once encoded as base64, plus room for the data URI prefix
const MAX_IMAGE_DATA_URI_LENGTH = 7 * 1024 * 1024;

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
    licenseDoc: z.string().max(MAX_IMAGE_DATA_URI_LENGTH).nullish(),
    logo: z.string().max(MAX_IMAGE_DATA_URI_LENGTH).nullish(),
  }),
});

export const companyRequestDocumentSchema = z.object({
  body: z.object({
    licenseDoc: z.string().min(1).max(MAX_IMAGE_DATA_URI_LENGTH),
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
