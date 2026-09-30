import { Hono } from 'hono';
import { z } from 'zod';
import { validationError } from '../../lib/errors';
import { mondayOf, mondayOfDay } from '../../lib/week';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import { createFunctionSchema, createKpiSchema, updateFunctionSchema, updateKpiSchema, weekQuerySchema } from './area.schemas';
import * as area from './area.service';
import * as weeks from './weeks.service';
import { exportDashboardExcel } from '../dashboard/export';
import { contentDisposition } from '../../lib/storage';
import { paginationSchema } from '../../lib/pagination';

const weekId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Week');
const deptId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Department');

const createWeekSchema = z.object({ mondayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional() });
const closeSchema = z.object({ force: z.boolean().default(false) });

export const weekRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const { limit } = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(104).default(12) }));
    return c.json(await weeks.listWeeks(c.get('user'), limit));
  })
  .get('/current', async (c) => {
    const user = c.get('user');
    return c.json({ week: weeks.presentWeek(await weeks.currentWeek(user.workspaceId, user.workspaceTimezone)) });
  })
  // Weeks start by themselves on Monday; this lets an ADMIN open one ahead (planning).
  .post('/', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    const { mondayDate } = await parseJson(c, createWeekSchema);
    if (mondayDate && mondayOfDay(mondayDate) !== mondayDate) {
      throw validationError('mondayDate must be a Monday', [{ field: 'mondayDate', message: 'not a Monday' }]);
    }
    const monday = mondayDate ?? mondayOf(new Date(), user.workspaceTimezone);
    const { week, created } = await weeks.ensureWeek(user.workspaceId, monday, user.id);
    return c.json({ week: weeks.presentWeek(week), created }, created ? 201 : 200);
  })
  // Registered before '/:id'.
  .get('/archived', async (c) => c.json(await weeks.listArchivedWeeks(c.get('user'), parseQuery(c, paginationSchema.extend({ limit: z.coerce.number().int().min(1).max(100).default(20) })))))
  .get('/:id', async (c) => {
    const user = c.get('user');
    const week = await weeks.findWeek(user, weekId(c));
    return c.json({ week: weeks.presentWeek(week) });
  })
  .get('/:id/closure-check', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    return c.json(await weeks.closureReport(user, await weeks.findWeek(user, weekId(c))));
  })
  .post('/:id/close', requireRole('ADMIN'), async (c) => {
    const id = weekId(c);
    const body = c.req.header('content-type')?.includes('application/json') ? await parseJson(c, closeSchema) : { force: false };
    return c.json(await weeks.closeWeek(c.get('user'), id, body.force, clientContext(c)));
  })
  // The week (its frozen snapshot when archived) as an Excel file.
  .post('/:id/export', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    const week = await weeks.findWeek(user, weekId(c));
    const { buffer, filename } = await exportDashboardExcel(user, week.id);
    return c.body(buffer, 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition('attachment', filename),
      'Cache-Control': 'no-store',
    });
  })
  // The frozen copy made at closing (live data for a week still open).
  .get('/:id/archive', async (c) => {
    const user = c.get('user');
    const week = await weeks.findWeek(user, weekId(c));
    return c.json({ archived: week.status === 'ARCHIVED', data: await weeks.weekData(user, week) });
  });

// Mounted under /departments.
export const areaRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/:id/kpis', async (c) => c.json(await area.listKpis(c.get('user'), deptId(c), parseQuery(c, weekQuerySchema).weekId)))
  .post('/:id/kpis', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const id = deptId(c);
    return c.json(await area.createKpi(c.get('user'), id, await parseJson(c, createKpiSchema), clientContext(c)), 201);
  })
  .patch('/:id/kpis/:kpiId', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const id = deptId(c);
    const kpiId = idParam(c, 'kpiId', 'KPI');
    return c.json(await area.updateKpi(c.get('user'), id, kpiId, await parseJson(c, updateKpiSchema), clientContext(c)));
  })
  .delete('/:id/kpis/:kpiId', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    await area.deleteKpi(c.get('user'), deptId(c), idParam(c, 'kpiId', 'KPI'), clientContext(c));
    return c.json({ success: true });
  })
  .get('/:id/functions', async (c) => c.json(await area.listFunctions(c.get('user'), deptId(c), parseQuery(c, weekQuerySchema).weekId)))
  .post('/:id/functions', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const id = deptId(c);
    return c.json(await area.createFunction(c.get('user'), id, await parseJson(c, createFunctionSchema), clientContext(c)), 201);
  })
  .patch('/:id/functions/:functionId', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const id = deptId(c);
    const functionId = idParam(c, 'functionId', 'Function');
    return c.json(await area.updateFunction(c.get('user'), id, functionId, await parseJson(c, updateFunctionSchema), clientContext(c)));
  })
  .delete('/:id/functions/:functionId', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    await area.deleteFunction(c.get('user'), deptId(c), idParam(c, 'functionId', 'Function'), clientContext(c));
    return c.json({ success: true });
  });

export const kpiRoutes = new Hono<AppEnv>().use('*', requireAuth).get('/templates', async (c) => c.json(await area.kpiTemplates(c.get('user'))));
