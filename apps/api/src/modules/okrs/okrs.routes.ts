import { Hono } from 'hono';
import { z } from 'zod';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import { checkInSchema, createOkrSchema, listOkrsSchema, updateOkrSchema } from './okrs.schemas';
import * as okrs from './okrs.service';

const okrId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'OKR');

// Mounted under /okrs. Literal paths before '/:id'.
export const okrRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => c.json(await okrs.listOkrs(c.get('user'), parseQuery(c, listOkrsSchema))))
  .get('/tree', async (c) => {
    const { period } = parseQuery(c, z.object({ period: z.string().regex(/^\d{4}-Q[1-4]$/, 'Use YYYY-Qn') }));
    return c.json(await okrs.okrTree(c.get('user'), period));
  })
  .post('/', requireRole('ADMIN', 'JEFE_AREA'), async (c) => c.json(await okrs.createOkr(c.get('user'), await parseJson(c, createOkrSchema), clientContext(c)), 201))
  .get('/:id', async (c) => c.json(await okrs.getOkr(c.get('user'), okrId(c))))
  .patch('/:id', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const id = okrId(c);
    return c.json(await okrs.updateOkr(c.get('user'), id, await parseJson(c, updateOkrSchema), clientContext(c)));
  })
  .delete('/:id', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    await okrs.deleteOkr(c.get('user'), okrId(c), clientContext(c));
    return c.json({ success: true });
  })
  .get('/:id/check-ins', async (c) => c.json(await okrs.listCheckIns(c.get('user'), okrId(c))))
  .post('/:id/check-ins', async (c) => {
    const id = okrId(c);
    return c.json(await okrs.checkIn(c.get('user'), id, await parseJson(c, checkInSchema), clientContext(c)), 201);
  });
