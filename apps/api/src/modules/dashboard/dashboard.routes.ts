import type { Prisma, Semaphore, TaskStatus } from '@prisma/client';
import { Hono } from 'hono';
import { z } from 'zod';
import { forbidden } from '../../lib/errors';
import { canSeeDepartment, departmentFilter, departmentScope } from '../../lib/permissions';
import { prisma } from '../../lib/prisma';
import { parseQuery } from '../../lib/validation';
import { requireAuth } from '../../middleware/auth';
import type { AppEnv, AuthUser } from '../../types';

const querySchema = z.object({ departmentId: z.string().uuid().optional() });

const STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];
const SEMAPHORES: Semaphore[] = ['GREEN', 'YELLOW', 'RED'];
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

  const [byStatus, bySemaphore, byDeptStatus, byDeptSemaphore, byDeptProgress, departments, recentLogs] = await Promise.all([
    prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['semaphore'], where, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['departmentId', 'status'], where, _count: { _all: true } }),
    prisma.task.groupBy({ by: ['departmentId', 'semaphore'], where, _count: { _all: true } }),
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
  const semaphore = zeroSemaphore();
  for (const row of bySemaphore) semaphore[row.semaphore] = row._count._all;

  const byDepartment = departments.map((d) => {
    const s = zeroStatus();
    const sem = zeroSemaphore();
    for (const r of byDeptStatus) if (r.departmentId === d.id) s[r.status] = r._count._all;
    for (const r of byDeptSemaphore) if (r.departmentId === d.id) sem[r.semaphore] = r._count._all;
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

export const dashboardRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => {
    const { departmentId } = parseQuery(c, querySchema);
    return c.json(await buildDashboard(c.get('user'), departmentId));
  });
