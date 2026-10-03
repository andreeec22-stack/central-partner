import { env } from '../config/env';
import { logger } from './logger';

// Error reporting to Sentry, only when SENTRY_DSN is set. Without it nothing is
// loaded and errors only go to the JSON logs. Only unexpected errors (5xx,
// unhandled rejections) are sent; no request bodies, cookies or headers.
type SentryModule = typeof import('@sentry/node');
let sentry: SentryModule | null = null;

export function initSentry() {
  if (!env.SENTRY_DSN || sentry) return;
  sentry = require('@sentry/node') as SentryModule;
  sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: env.APP_VERSION || undefined,
    // Nothing personal or secret: no user info, cookies, headers, query strings or bodies.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, urlQueryParams: false, httpBodies: [], stackFrameVariables: false },
    tracesSampleRate: 0,
    // We report 5xx ourselves; the default integrations would also hook the
    // process handlers that index.ts already owns.
    defaultIntegrations: false,
  });
  logger.info('sentry enabled', { environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV });
}

export function captureError(error: unknown, context: { requestId?: string; endpoint?: string; userId?: string } = {}) {
  if (!sentry) return;
  sentry.withScope((scope) => {
    if (context.requestId) scope.setTag('requestId', context.requestId);
    if (context.endpoint) scope.setTag('endpoint', context.endpoint);
    if (context.userId) scope.setUser({ id: context.userId });
    sentry!.captureException(error);
  });
}

export async function flushSentry() {
  if (sentry) await sentry.close(2000).catch(() => false);
}
