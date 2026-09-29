import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cookieSecure, env } from '../../config/env';
import { forbidden } from '../../lib/errors';
import type { AppEnv } from '../../types';

const REFRESH_COOKIE = 'cp_refresh';
const COOKIE_PATH = '/api/v1/auth';

export function setRefreshCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: env.COOKIE_SAMESITE,
    path: COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function clearRefreshCookie(c: Context<AppEnv>) {
  deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH, secure: cookieSecure, sameSite: env.COOKIE_SAMESITE });
}

// A cookie is sent automatically by the browser, so a cookie-authenticated request
// must come from one of our own origins (CSRF guard). Body tokens don't need this.
function assertTrustedOrigin(c: Context<AppEnv>) {
  const origin = c.req.header('origin');
  if (!origin || env.CORS_ORIGIN.length === 0) return;
  if (!env.CORS_ORIGIN.includes(origin)) throw forbidden('Untrusted origin');
}

export function readRefreshToken(c: Context<AppEnv>, fromBody: string | undefined): string | undefined {
  if (fromBody) return fromBody;
  const fromCookie = getCookie(c, REFRESH_COOKIE);
  if (fromCookie) assertTrustedOrigin(c);
  return fromCookie;
}
