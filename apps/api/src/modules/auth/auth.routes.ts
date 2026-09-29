import type { Context } from 'hono';
import { Hono } from 'hono';
import { env } from '../../config/env';
import { unauthorized } from '../../lib/errors';
import { verifyAccessToken } from '../../lib/tokens';
import { parseJson } from '../../lib/validation';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import type { AppEnv } from '../../types';
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
} from './auth.schemas';
import * as auth from './auth.service';
import { clearRefreshCookie, readRefreshToken, setRefreshCookie } from './cookies';

export function clientContext(c: Context<AppEnv>): auth.ClientContext {
  return { ipAddress: c.get('clientIp'), userAgent: c.req.header('user-agent') };
}

export const authLimiter = (prefix: string) =>
  rateLimit({ prefix, max: env.AUTH_RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS, keyBy: (c) => c.get('clientIp') });

export const authRoutes = new Hono<AppEnv>()
  .post('/register', authLimiter('auth:register'), async (c) => {
    const input = await parseJson(c, registerSchema);
    const result = await auth.register(input, clientContext(c));
    setRefreshCookie(c, result.refreshToken);
    return c.json(result, 201);
  })

  .post('/login', authLimiter('auth:login'), async (c) => {
    const input = await parseJson(c, loginSchema);
    const result = await auth.login(input, clientContext(c));
    setRefreshCookie(c, result.refreshToken);
    return c.json(result);
  })

  .post('/refresh-token', authLimiter('auth:refresh'), async (c) => {
    const body = c.req.header('content-type')?.includes('application/json') ? await parseJson(c, refreshSchema) : {};
    const token = readRefreshToken(c, body.refreshToken);
    if (!token) throw unauthorized('Refresh token missing', 'REFRESH_INVALID');
    try {
      const result = await auth.refresh(token, clientContext(c));
      setRefreshCookie(c, result.refreshToken);
      return c.json(result);
    } catch (err) {
      clearRefreshCookie(c);
      throw err;
    }
  })

  // Works with either a valid access token or the refresh cookie, so a user whose
  // access token already expired can still end their session cleanly.
  .post('/logout', async (c) => {
    const header = c.req.header('authorization');
    const claims = header?.startsWith('Bearer ') ? verifyAccessToken(header.slice(7).trim()) : null;
    let sessionId = claims?.sid ?? null;
    if (!sessionId) {
      const refreshToken = readRefreshToken(c, undefined);
      if (refreshToken) sessionId = await auth.sessionIdForRefreshToken(refreshToken);
    }
    if (sessionId) await auth.logout(sessionId, clientContext(c));
    clearRefreshCookie(c);
    return c.json({ success: true });
  })

  .post('/reset-password', authLimiter('auth:reset'), async (c) => {
    const { email } = await parseJson(c, resetRequestSchema);
    await auth.requestPasswordReset(email, clientContext(c));
    return c.json({ message: 'If an account exists for that email, a reset link has been sent' });
  })

  .post('/reset-password/confirm', authLimiter('auth:reset-confirm'), async (c) => {
    const { token, newPassword } = await parseJson(c, resetConfirmSchema);
    await auth.confirmPasswordReset(token, newPassword, clientContext(c));
    clearRefreshCookie(c);
    return c.json({ success: true });
  })

  .get('/me', requireAuth, async (c) => c.json(await auth.getCurrentUser(c.get('user').id)));
