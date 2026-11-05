import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Secrets published in .env.example; a server running with one of them accepts forged tokens
const PUBLISHED_EXAMPLE_SECRETS = ['super_secure_jwt_secret_key_change_in_production_123456789'];

const envSchema = z.object({
  PORT: z.string().default('5000').transform(val => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long for deep security'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // Comma separated list of browser origins allowed to call the API. '*' allows any origin without credentials.
  CORS_ORIGIN: z.string().default('*'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required for PostgreSQL connection'),
  PUBLIC_SERVER_URL: z.string().url().optional(),
  // Which proxies may set X-Forwarded-For. The default trusts only private and loopback addresses (nginx on the same host or network).
  TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  // Local time zone of the platform: decides when an appointment day has ended
  APP_TIMEZONE: z.string().default('Africa/Cairo').refine((tz) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }, 'APP_TIMEZONE must be a valid IANA time zone such as Africa/Cairo'),
});

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid Environment Variables Configuration:', JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }

  if (result.data.NODE_ENV === 'production' && PUBLISHED_EXAMPLE_SECRETS.includes(result.data.JWT_SECRET)) {
    console.error('❌ JWT_SECRET is the example value from .env.example. Set a private random secret before starting in production.');
    process.exit(1);
  }

  return result.data;
};

export const env = parseEnv();
