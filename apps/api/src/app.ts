import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { getRedis } from './lib/redis';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { rateLimit } from './middleware/rate-limit';
import { requestContext } from './middleware/request-context';
import { authRoutes } from './modules/auth/auth.routes';
import { departmentRoutes } from './modules/departments/departments.routes';
import { taskRoutes } from './modules/tasks/tasks.routes';
import { publicUserRoutes, userRoutes } from './modules/users/users.routes';
import type { AppEnv } from './types';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext);
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: (origin) => (env.CORS_ORIGIN.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.get('/health', async (c) => {
    const database = await prisma.$queryRaw`SELECT 1`.then(
      () => 'ok' as const,
      () => 'down' as const,
    );
    const redis = env.REDIS_URL ? (getRedis() ? 'ok' : 'down') : 'disabled';
    return c.json({ status: database === 'ok' ? 'ok' : 'degraded', database, redis }, database === 'ok' ? 200 : 503);
  });

  const api = new Hono<AppEnv>();
  api.use('*', rateLimit({ prefix: 'api', max: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS }));
  api.route('/auth', authRoutes);
  api.route('/users', publicUserRoutes);
  api.route('/users', userRoutes);
  api.route('/departments', departmentRoutes);
  api.route('/tasks', taskRoutes);

  app.route('/api/v1', api);

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}
