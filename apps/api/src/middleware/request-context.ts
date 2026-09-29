import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import type { AppEnv } from '../types';

// Behind Railway's proxy (TRUST_PROXY=true) the client IP is the hop the proxy
// appended — the rightmost X-Forwarded-For entry; entries to its left are
// client-supplied and spoofable. Otherwise use the socket address.
function clientIpOf(c: Context<AppEnv>): string {
  if (env.TRUST_PROXY) {
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no socket (e.g. in-process test requests)
  }
}

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set('requestId', requestId);
  c.set('clientIp', clientIpOf(c));
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
