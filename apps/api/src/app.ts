import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { getRedis } from './lib/redis';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { rateLimit, userOrIpKey } from './middleware/rate-limit';
import { requestContext } from './middleware/request-context';
import { authRoutes } from './modules/auth/auth.routes';
import { brandingRoutes, publicBrandingRoutes } from './modules/branding/branding.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { departmentRoutes } from './modules/departments/departments.routes';
import { excelImportRoutes } from './modules/excel-imports/excel-imports.routes';
import { storageRoutes } from './modules/storage/storage.routes';
import { areaRoutes, kpiRoutes, weekRoutes } from './modules/weeks/weeks.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { permissionRoutes } from './modules/permissions/permissions.routes';
import { workspaceRoutes } from './modules/workspace/workspace.routes';
import { performanceRoutes } from './modules/performance/performance.routes';
import { reviewRoutes, surveyRoutes } from './modules/surveys/surveys.routes';
import { okrRoutes } from './modules/okrs/okrs.routes';
import { scorecardRoutes } from './modules/scorecard/scorecard.routes';
import { taskRoutes } from './modules/tasks/tasks.routes';
import { publicUserRoutes, userRoutes } from './modules/users/users.routes';
import type { AppEnv } from './types';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext);
  // Logos and signed file links are loaded cross-origin (<img>, downloads from
  // the SPA's domain); everything else keeps the strict same-origin policy.
  const strictHeaders = secureHeaders();
  const assetHeaders = secureHeaders({ crossOriginResourcePolicy: 'cross-origin' });
  const isAsset = (path: string) => path.startsWith('/api/v1/public/') || path.startsWith('/api/v1/storage/');
  app.use('*', (c, next) => (isAsset(c.req.path) ? assetHeaders : strictHeaders)(c, next));
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
  // Per signed-in user (per IP only for anonymous calls); /auth adds its own per-IP limits.
  api.use('*', rateLimit({ prefix: 'api', max: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS, keyBy: userOrIpKey }));
  api.route('/auth', authRoutes);
  api.route('/users', publicUserRoutes);
  api.route('/users', userRoutes);
  api.route('/departments', departmentRoutes);
  api.route('/departments', areaRoutes);
  api.route('/weeks', weekRoutes);
  api.route('/workspace', workspaceRoutes);
  api.route('/permissions', permissionRoutes);
  api.route('/audit-logs', auditRoutes);
  api.route('/kpis', kpiRoutes);
  api.route('/tasks', taskRoutes);
  api.route('/dashboard', dashboardRoutes);
  api.route('/excel-imports', excelImportRoutes);
  api.route('/workspaces', brandingRoutes);
  api.route('/workspaces', performanceRoutes);
  api.route('/surveys', surveyRoutes);
  api.route('/performance-reviews', reviewRoutes);
  api.route('/okrs', okrRoutes);
  api.route('/performance-dashboard', scorecardRoutes);
  api.route('/public', publicBrandingRoutes);
  api.route('/storage', storageRoutes);

  app.route('/api/v1', api);

  app.notFound(notFoundHandler);
  app.onError(errorHandler);
  return app;
}
