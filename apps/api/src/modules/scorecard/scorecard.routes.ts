import { Hono } from 'hono';
import { z } from 'zod';
import { parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { scorecard } from './scorecard.service';

// Mounted under /performance-dashboard.
export const scorecardRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const q = parseQuery(
      c,
      z.object({
        period: z.string().regex(/^\d{4}-Q[1-4]$/, 'Use YYYY-Qn').optional(),
        departmentId: z.string().uuid().optional(),
      }),
    );
    return c.json(await scorecard(c.get('user'), q));
  });
