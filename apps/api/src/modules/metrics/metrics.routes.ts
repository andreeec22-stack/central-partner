import { Hono } from 'hono';
import { getMetricsSummary } from '../../lib/metrics';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';

// Mounted under /admin/metrics. ADMIN only. Numbers are per API instance.
export const metricsRoutes = new Hono<AppEnv>()
  .use('*', requireAuth, requireRole('ADMIN'))
  .get('/', (c) => c.json(getMetricsSummary()));
