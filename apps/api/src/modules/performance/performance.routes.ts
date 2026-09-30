import { Hono } from 'hono';
import { z } from 'zod';
import { idParam, parseQuery } from '../../lib/validation';
import { requireAuth } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { DEFAULT_WINDOW_WEEKS, performanceFor } from './performance.service';

// Mounted under /workspaces (Module 1).
export const performanceRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/:id/team/:userId/performance', async (c) => {
    const { weeks } = parseQuery(c, z.object({ weeks: z.coerce.number().int().min(1).max(26).default(DEFAULT_WINDOW_WEEKS) }));
    const report = await performanceFor(c.get('user'), idParam(c, 'id', 'Workspace'), idParam(c, 'userId', 'User'), weeks);
    return c.json({ performance: report });
  });
