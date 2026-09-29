import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { logger } from '../lib/logger';
import type { AppEnv } from '../types';

// Railway terminates TLS in a proxy, so the client IP is the first X-Forwarded-For hop.
function clientIpOf(header: string | undefined): string {
  const first = header?.split(',')[0]?.trim();
  return first || 'unknown';
}

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set('requestId', requestId);
  c.set('clientIp', clientIpOf(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip')));
  c.header('X-Request-Id', requestId);

  const started = performance.now();
  await next();
  const durationMs = Math.round((performance.now() - started) * 10) / 10;

  const user = c.get('user');
  const fields = {
    requestId,
    method: c.req.method,
    endpoint: c.req.routePath === '/*' ? c.req.path : c.req.routePath,
    path: c.req.path,
    status: c.res.status,
    durationMs,
    userId: user?.id,
    workspaceId: user?.workspaceId,
  };
  if (c.res.status >= 500) logger.error('request', fields);
  else logger.info('request', fields);
});
