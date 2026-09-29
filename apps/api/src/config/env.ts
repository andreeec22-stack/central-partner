import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_URL: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default(''),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Gap 4: access 1h, refresh 7d with sliding renewal.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  // Cross-site cookies (Vercel frontend ↔ Railway API) need SameSite=None + Secure.
  COOKIE_SAMESITE: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  CORS_ORIGIN: csv,
  // true only when running behind a proxy that sets X-Forwarded-For (Railway).
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('Central Partner <noreply@centralpartner.local>'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';
export const cookieSecure = env.COOKIE_SECURE ?? isProduction;
