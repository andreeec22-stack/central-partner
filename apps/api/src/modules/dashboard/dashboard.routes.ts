import type { Prisma, Semaphore, TaskStatus } from '@prisma/client';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { forbidden, notFound } from '../../lib/errors';
import { contentDisposition } from '../../lib/storage';
import { dateToDay, localDay } from '../../lib/week';
import { taskSemaphore } from '../../lib/weekly-metrics';
import { canSeeDepartment, departmentFilter, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth } from '../../middleware/auth';
import type { AppEnv, AuthUser } from '../../types';
import { exportDashboardExcel } from './export';
import { departmentWeek, trends, weekDashboard, weekHistory } from './weekly-dashboard.service';

const querySchema = z.object({ departmentId: z.string().uuid().optional() });

const STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];
const SEMAPHORES: Semaphore[] = ['GREEN', 'YELLOW', 'RED', 'GRAY'];
const zeroStatus = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
const zeroSemaphore = () => Object.fromEntries(SEMAPHORES.map((s) => [s, 0])) as Record<Semaphore, number>;

// Everything is computed from the caller's visible departments only, so a
// dashboard can never reveal numbers from a department the user can't see.
async function buildDashboard(user: AuthUser, departmentId?: string) {
  const scope = await departmentScope(user);
  if (departmentId && !canSeeDepartment(scope, departmentId)) throw forbidden('You cannot see that department');
  const where: Prisma.TaskWhereInput = {
    workspaceId: user.workspaceId,
    deletedAt: null,
    departmentId: departmentId ?? departmentFilter(scope),
  };

  const [byStatus, semaphoreRows, byDeptStatus, byDeptProgress, departments, recentLogs] = await Promise.all([
    prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } }),
    // The semaphore depends on today's date, so it is counted here, not stored.
    prisma.task.findMany({ where, select: { departmentId: true, progress: true, dueDate: true, week: { select: { mondayDate: true } } } }),
    prisma.task.groupBy({ by: ['departmentId', 'status'], where, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['departmentId'], where, _avg: { progress: true } }),
    prisma.department.findMany({
      where: { workspaceId: user.workspaceId, deletedAt: null, id: departmentId ?? departmentFilter(scope) },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.activityLog.findMany({
      where: { workspaceId: user.workspaceId, entityType: 'Task' },
      include: { user: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ]);

  const status = zeroStatus();
  for (const row of byStatus) status[row.status] = row._count._all;
  const tz = user.workspaceTimezone;
  const today = localDay(new Date(), tz);
  const taskSemaphores = semaphoreRows.map((t) => ({
    departmentId: t.departmentId,
    semaphore: taskSemaphore(t, t.week ? dateToDay(t.week.mondayDate) : null, today, tz),
  }));
  const semaphore = zeroSemaphore();
  for (const t of taskSemaphores) semaphore[t.semaphore]++;

  const byDepartment = departments.map((d) => {
    const s = zeroStatus();
    const sem = zeroSemaphore();
    for (const r of byDeptStatus) if (r.departmentId === d.id) s[r.status] = r._count._all;
    for (const t of taskSemaphores) if (t.departmentId === d.id) sem[t.semaphore]++;
    const avg = byDeptProgress.find((r) => r.departmentId === d.id)?._avg.progress ?? null;
    return {
      ...d,
      totalTasks: STATUSES.reduce((n, k) => n + s[k], 0),
      status: s,
      semaphore: sem,
      averageProgress: avg === null ? null : Math.round(avg),
    };
  });

  // Activity is filtered to tasks the caller can see (entityId is not a FK).
  const candidateIds = [...new Set(recentLogs.map((l) => l.entityId).filter((id): id is string => !!id))];
  const visible = await prisma.task.findMany({
    where: { id: { in: candidateIds }, workspaceId: user.workspaceId, departmentId: departmentId ?? departmentFilter(scope) },
    select: { id: true, title: true, departmentId: true },
  });
  const visibleById = new Map(visible.map((t) => [t.id, t]));
  const recentActivity = recentLogs
    .filter((l) => l.entityId && visibleById.has(l.entityId))
    .slice(0, 20)
    .map((l) => ({
      id: l.id,
      action: l.action,
      createdAt: l.createdAt,
      actor: l.user,
      task: visibleById.get(l.entityId!)!,
      changes: l.changes,
    }));

  return {
    summary: {
      totalTasks: STATUSES.reduce((n, k) => n + status[k], 0),
      todoCount: status.TODO,
      inProgressCount: status.IN_PROGRESS,
      blockedCount: status.BLOCKED,
      completedCount: status.DONE,
    },
    semaphore,
    byDepartment,
    recentActivity,
    generatedAt: new Date(),
  };
}

const weekRefSchema = z.union([z.literal('current'), z.string().uuid()]);
const historySchema = querySchema.extend({
  limit: z.coerce.number().int().min(1).max(12).default(3),
  includeCurrent: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});
const exportSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  weekId: weekRefSchema.default('current'),
  areaId: z.string().uuid().optional(),
  format: z.literal('xlsx').default('xlsx'),
});

function excelResponse(c: Context<AppEnv>, file: { buffer: Uint8Array<ArrayBuffer>; filename: string }) {
  return c.body(file.buffer, 200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': contentDisposition('attachment', file.filename),
    'Cache-Control': 'no-store',
  });
}

const weekRef = (c: Parameters<typeof idParam>[0]) => (c.req.param('weekId') === 'current' ? 'current' : idParam(c, 'weekId', 'Week'));

export const dashboardRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const { departmentId } = parseQuery(c, querySchema);
    return c.json(await buildDashboard(c.get('user'), departmentId));
  })
  // Weekly cycle. Registered before '/week/:weekId' so "history" isn't read as an id.
  .get('/week/history', async (c) => {
    const q = parseQuery(c, historySchema);
    return c.json(await weekHistory(c.get('user'), { limit: q.limit, includeCurrent: q.includeCurrent, departmentId: q.departmentId }));
  })
  // :weekId accepts "current".
  .get('/week/:weekId', async (c) => {
    const { departmentId } = parseQuery(c, querySchema);
    return c.json(await weekDashboard(c.get('user'), weekRef(c), departmentId));
  })
  .get('/department/:departmentId/week/:weekId', async (c) =>
    c.json(await departmentWeek(c.get('user'), idParam(c, 'departmentId', 'Department'), weekRef(c))),
  )
  .get('/trends', async (c) => {
    const q = parseQuery(c, querySchema.extend({ weeks: z.coerce.number().int().min(1).max(26).default(4) }));
    return c.json(await trends(c.get('user'), q.weeks, q.departmentId));
  })
  .get('/export/excel', async (c) => {
    const q = parseQuery(c, z.object({ weekId: weekRefSchema.default('current'), departmentId: z.string().uuid().optional() }));
    return excelResponse(c, await exportDashboardExcel(c.get('user'), q.weekId, q.departmentId));
  })
  // Same file, with the dashboard's current filters in the body.
  .post('/export/excel', async (c) => {
    const user = c.get('user');
    const body = await parseJson(c, exportSchema);
    // The token already scopes the workspace; a different id in the body is simply not found.
    if (body.workspaceId && body.workspaceId !== user.workspaceId) throw notFound('Workspace');
    return excelResponse(c, await exportDashboardExcel(user, body.weekId, body.areaId));
  });
