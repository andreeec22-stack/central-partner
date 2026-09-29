import { prisma } from '../../src/lib/prisma';
import { createTask, seedWorkspace, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});

afterAll(() => prisma.$disconnect());

const patch = (token: string, id: string, body: unknown) => call('PATCH', `/api/v1/tasks/${id}`, { token, body });
const listIds = async (token: string, query = '') =>
  (await call('GET', `/api/v1/tasks${query}`, { token })).body.data.map((t: { id: string }) => t.id);

describe('who can create tasks', () => {
  const create = (token: string, body: Record<string, unknown> = { title: 'Tarea' }) =>
    call('POST', '/api/v1/tasks', { token, body });

  it('ADMIN always can', async () => {
    expect((await create(s.admin.token, { title: 'x', departmentId: s.marketing })).status).toBe(201);
  });

  it('JEFE_AREA with can_create_tasks can, in their own department', async () => {
    expect((await create(s.mkt.jefe.token)).status).toBe(201);
    expect((await create(s.mkt.jefe.token, { title: 'x', departmentId: s.finanzas })).status).toBe(403);
  });

  it('JEFE_AREA without the grant cannot', async () => {
    const res = await create(s.mkt.jefeNoGrant.token);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('No tienes permiso para crear tareas');
  });

  it('USER and VIEWER never can', async () => {
    expect((await create(s.mkt.user.token)).status).toBe(403);
    expect((await create(s.mkt.viewer.token)).status).toBe(403);
    expect(await prisma.task.count()).toBe(0);
  });

  it('granting or revoking takes effect on the next request', async () => {
    expect((await create(s.mkt.jefeNoGrant.token)).status).toBe(403);
    await call('PATCH', `/api/v1/users/${s.mkt.jefeNoGrant.id}`, { token: s.admin.token, body: { canCreateTasks: true } });
    expect((await create(s.mkt.jefeNoGrant.token)).status).toBe(201);
    await call('PATCH', `/api/v1/users/${s.mkt.jefeNoGrant.id}`, { token: s.admin.token, body: { canCreateTasks: false } });
    expect((await create(s.mkt.jefeNoGrant.token)).status).toBe(403);
  });
});

describe('creating tasks', () => {
  it('creates with normalized fields and an audit entry', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: '  Publicar 5 posts  ', kpiTarget: '5 posts' });
    expect(task).toMatchObject({
      title: 'Publicar 5 posts',
      departmentId: s.marketing,
      assignedToId: s.mkt.user.id,
      createdById: s.mkt.jefe.id,
      status: 'TODO',
      progress: 0,
      semaphore: 'RED',
      priority: 'MEDIUM',
      sourceType: 'MANUAL',
    });
    const log = await prisma.activityLog.findFirst({ where: { action: 'TASK_CREATED', entityId: task.id } });
    expect(log?.userId).toBe(s.mkt.jefe.id);
  });

  it('is unassigned unless an assignee is given', async () => {
    expect((await createTask(s.mkt.jefe.token, { title: 'Sin asignar' })).assignedToId).toBeNull();
  });

  it('refuses out-of-department and viewer assignees', async () => {
    const foreign = await call('POST', '/api/v1/tasks', { token: s.mkt.jefe.token, body: { title: 'x', assignedTo: s.fin.user.id } });
    expect(foreign.status).toBe(422);
    const toViewer = await call('POST', '/api/v1/tasks', { token: s.mkt.jefe.token, body: { title: 'x', assignedTo: s.mkt.viewer.id } });
    expect(toViewer.status).toBe(422);
  });

  it('the director (no department) must pick one, and can create anywhere', async () => {
    expect((await call('POST', '/api/v1/tasks', { token: s.admin.token, body: { title: 'x' } })).status).toBe(422);
    const task = await createTask(s.admin.token, { title: 'Cierre mensual', departmentId: s.finanzas, assignedTo: s.fin.user.id });
    expect(task.assignedToId).toBe(s.fin.user.id);
  });
});

describe('visibility (RBAC)', () => {
  it('users never see other departments’ tasks', async () => {
    const mkt = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Campaña' });
    const fin = await createTask(s.fin.jefe.token, { assignedTo: s.fin.user.id, title: 'Conciliación' });

    expect(await listIds(s.mkt.user.token)).toEqual([mkt.id]);
    expect(await listIds(s.mkt.viewer.token)).toEqual([mkt.id]);
    expect(await listIds(s.fin.jefe.token)).toEqual([fin.id]);
    expect((await listIds(s.admin.token)).sort()).toEqual([mkt.id, fin.id].sort());

    expect((await call('GET', `/api/v1/tasks/${fin.id}`, { token: s.mkt.user.token })).status).toBe(404);
    expect((await patch(s.mkt.jefe.token, fin.id, { progress: 25 })).status).toBe(404);
    expect((await call('GET', `/api/v1/tasks?departmentId=${s.finanzas}`, { token: s.mkt.user.token })).status).toBe(403);
  });

  it('visibility grants let a JEFE_AREA read, but not edit, another department', async () => {
    const fin = await createTask(s.fin.jefe.token, { assignedTo: s.fin.user.id, title: 'Conciliación' });
    await prisma.departmentVisibility.create({
      data: { workspaceId: s.workspaceId, jefeAreaId: s.mkt.jefe.id, visibleDepartmentIds: [s.finanzas] },
    });
    expect(await listIds(s.mkt.jefe.token)).toEqual([fin.id]);
    expect((await call('GET', `/api/v1/tasks/${fin.id}`, { token: s.mkt.jefe.token })).status).toBe(200);
    expect((await patch(s.mkt.jefe.token, fin.id, { progress: 25 })).status).toBe(403);
  });

  it('edit rights: assignee, creator, own-area JEFE and ADMIN — not other USERs or VIEWERs', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Brief', assignedTo: s.mkt.user.id });
    expect((await patch(s.mkt.user.token, task.id, { progress: 25 })).status).toBe(200); // assignee
    expect((await patch(s.mkt.jefe.token, task.id, { progress: 50 })).status).toBe(200); // creator & jefe
    expect((await patch(s.admin.token, task.id, { priority: 'HIGH' })).status).toBe(200);
    expect((await patch(s.mkt.user2.token, task.id, { progress: 75 })).status).toBe(403);
    expect((await patch(s.mkt.viewer.token, task.id, { progress: 75 })).status).toBe(403);
  });

  it('only the ADMIN moves tasks between departments', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Mover' });
    expect((await patch(s.mkt.jefe.token, task.id, { departmentId: s.finanzas })).status).toBe(403);
    const moved = await patch(s.admin.token, task.id, { departmentId: s.finanzas });
    expect(moved.status).toBe(200);
    expect(await listIds(s.mkt.jefe.token)).toEqual([]);
  });
});

describe('daily progress and semaphore', () => {
  it('follows 0/25/50/75/100 and derives status and semaphore', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Reporte' });
    expect((await patch(s.mkt.user.token, task.id, { progress: 30 })).status).toBe(422);

    const p75 = await patch(s.mkt.user.token, task.id, { progress: 75 });
    expect(p75.body.task).toMatchObject({ progress: 75, semaphore: 'YELLOW', status: 'IN_PROGRESS' });

    const p100 = await patch(s.mkt.user.token, task.id, { progress: 100 });
    expect(p100.body.task).toMatchObject({ progress: 100, semaphore: 'GREEN', status: 'DONE' });
    expect(p100.body.task.actualCompletionDate).not.toBeNull();

    const logs = await prisma.activityLog.findMany({ where: { entityId: task.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['TASK_CREATED', 'TASK_UPDATED', 'TASK_COMPLETED']);
    expect(logs[1]!.changes).toMatchObject({ progress: { old: 0, new: 75 }, semaphore: { old: 'RED', new: 'YELLOW' } });
  });

  it('records the KPI actual with a timestamp', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Leads', kpiTarget: '50 leads' });
    const res = await patch(s.mkt.user.token, task.id, { kpiActual: '47 leads' });
    expect(res.body.task).toMatchObject({ kpiTarget: '50 leads', kpiActual: '47 leads' });
    expect(res.body.task.kpiRecordedAt).not.toBeNull();
  });

  it('a no-op update writes nothing to the audit log', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Igual' });
    await patch(s.mkt.user.token, task.id, { title: 'Igual' });
    expect(await prisma.activityLog.count({ where: { entityId: task.id } })).toBe(1);
  });
});

describe('blocking', () => {
  it('requires a reason, records who/when, and clears on unblock', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Pauta' });

    const missing = await patch(s.mkt.user.token, task.id, { status: 'BLOCKED' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('blockReason');

    const blocked = await patch(s.mkt.user.token, task.id, { status: 'BLOCKED', blockReason: 'Esperando aprobación de finanzas' });
    expect(blocked.body.task).toMatchObject({
      status: 'BLOCKED',
      blockReason: 'Esperando aprobación de finanzas',
      blockedByUserId: s.mkt.user.id,
      wasBlocked: true,
    });
    expect(blocked.body.task.blockedSince).not.toBeNull();

    expect(await listIds(s.mkt.jefe.token, '?status=BLOCKED')).toEqual([task.id]);
    expect(await listIds(s.mkt.jefe.token, '?includeBlocked=false')).toEqual([]);

    const unblocked = await patch(s.mkt.user.token, task.id, { status: 'IN_PROGRESS' });
    expect(unblocked.body.task).toMatchObject({ status: 'IN_PROGRESS', blockReason: null, blockedSince: null, wasBlocked: true });

    const actions = (await prisma.activityLog.findMany({ where: { entityId: task.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions).toEqual(['TASK_CREATED', 'TASK_BLOCKED', 'TASK_UNBLOCKED']);
  });

  it('the database itself refuses a blocked task without a reason', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'x' });
    await expect(prisma.task.update({ where: { id: task.id }, data: { status: 'BLOCKED' } })).rejects.toThrow(/tasks_blocked_requires_reason/);
  });
});

describe('filters', () => {
  it('filters by week in the user timezone, assignee, priority and text', async () => {
    const now = Date.now();
    const thisWeek = await createTask(s.mkt.jefe.token, { title: 'Informe semanal', dueDate: new Date(now).toISOString(), priority: 'URGENT' });
    const nextWeek = await createTask(s.mkt.jefe.token, { title: 'Plan', dueDate: new Date(now + 8 * 86_400_000).toISOString(), assignedTo: s.mkt.user.id });

    expect(await listIds(s.mkt.jefe.token, '?week=this')).toEqual([thisWeek.id]);
    expect(await listIds(s.mkt.jefe.token, '?week=next')).toEqual([nextWeek.id]);
    expect(await listIds(s.mkt.user.token, '?assignedTo=me')).toEqual([nextWeek.id]);
    expect(await listIds(s.mkt.jefe.token, '?assignedTo=unassigned')).toEqual([thisWeek.id]);
    expect(await listIds(s.mkt.jefe.token, '?priority=URGENT,HIGH')).toEqual([thisWeek.id]);
    expect(await listIds(s.mkt.jefe.token, '?search=informe')).toEqual([thisWeek.id]);
    expect((await call('GET', '/api/v1/tasks?status=NOPE', { token: s.mkt.jefe.token })).status).toBe(422);
  });

  it('paginates with a total', async () => {
    for (let i = 0; i < 3; i++) await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: `T${i}` });
    const page = await call('GET', '/api/v1/tasks?limit=2&page=2&sortBy=title&sortOrder=asc', { token: s.mkt.user.token });
    expect(page.body).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page.body.data.map((t: { title: string }) => t.title)).toEqual(['T2']);
  });
});

describe('bulk update', () => {
  it('is all-or-nothing', async () => {
    const a = await createTask(s.mkt.jefe.token, { title: 'A' });
    const b = await createTask(s.mkt.jefe.token, { title: 'B' });
    const foreign = await createTask(s.fin.jefe.token, { assignedTo: s.fin.user.id, title: 'F' });

    const failed = await call('POST', '/api/v1/tasks/bulk-update', {
      token: s.mkt.jefe.token,
      body: { taskIds: [a.id, b.id, foreign.id], updates: { priority: 'URGENT' } },
    });
    expect(failed.status).toBe(422);
    expect(failed.body.error.details.failed).toEqual([{ taskId: foreign.id, code: 'NOT_FOUND', reason: 'Task not found' }]);
    expect(await prisma.task.count({ where: { priority: 'URGENT' } })).toBe(0);

    const ok = await call('POST', '/api/v1/tasks/bulk-update', {
      token: s.mkt.jefe.token,
      body: { taskIds: [a.id, b.id], updates: { status: 'BLOCKED', blockReason: 'Sin presupuesto' } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ successful: [a.id, b.id], failed: [], updatedCount: 2 });
    expect(await prisma.task.count({ where: { status: 'BLOCKED', blockReason: 'Sin presupuesto' } })).toBe(2);
  });

  it('is limited to managers and to 100 tasks', async () => {
    const a = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'A' });
    expect((await call('POST', '/api/v1/tasks/bulk-update', { token: s.mkt.user.token, body: { taskIds: [a.id], updates: { priority: 'LOW' } } })).status).toBe(403);
    const tooMany = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await call('POST', '/api/v1/tasks/bulk-update', { token: s.admin.token, body: { taskIds: tooMany, updates: { priority: 'LOW' } } })).status).toBe(422);
  });
});

describe('dependencies and sub-tasks', () => {
  it('rejects circular dependencies with the full chain', async () => {
    const [a, b, c] = [
      await createTask(s.mkt.jefe.token, { title: 'Diseño' }),
      await createTask(s.mkt.jefe.token, { title: 'Copy' }),
      await createTask(s.mkt.jefe.token, { title: 'Publicación' }),
    ];
    const dep = (task: string, on: string) =>
      call('POST', `/api/v1/tasks/${task}/dependencies`, { token: s.mkt.jefe.token, body: { dependsOnTaskId: on } });

    expect((await dep(c.id, b.id)).status).toBe(201);
    expect((await dep(b.id, a.id)).status).toBe(201);
    const cycle = await dep(a.id, c.id);
    expect(cycle.status).toBe(422);
    expect(cycle.body.error.code).toBe('CIRCULAR_DEPENDENCY');
    expect(cycle.body.error.details.cycle.map((t: { title: string }) => t.title)).toEqual(['Diseño', 'Publicación', 'Copy', 'Diseño']);
    expect((await dep(a.id, a.id)).status).toBe(422);

    const detail = await call('GET', `/api/v1/tasks/${c.id}`, { token: s.mkt.jefe.token });
    expect(detail.body.dependencies.map((d: { id: string }) => d.id)).toEqual([b.id]);

    expect((await call('DELETE', `/api/v1/tasks/${c.id}/dependencies/${b.id}`, { token: s.mkt.jefe.token })).status).toBe(200);
    expect((await dep(a.id, c.id)).status).toBe(201); // no longer circular
  });

  it('rejects nesting a task under its own sub-task', async () => {
    const parent = await createTask(s.mkt.jefe.token, { title: 'Lanzamiento' });
    const child = await createTask(s.mkt.jefe.token, { title: 'Landing', parentTaskId: parent.id });
    const res = await patch(s.mkt.jefe.token, parent.id, { parentTaskId: child.id });
    expect(res.status).toBe(422);
    const detail = await call('GET', `/api/v1/tasks/${parent.id}`, { token: s.mkt.jefe.token });
    expect(detail.body.subTasks.map((t: { id: string }) => t.id)).toEqual([child.id]);
  });
});

describe('deleting', () => {
  it('soft-deletes the task and archives its files', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Borrar' });
    await prisma.taskFile.create({
      data: { workspaceId: s.workspaceId, taskId: task.id, uploadedById: s.mkt.user.id, filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, storageKey: 'k' },
    });
    // The assignee may update it but not delete it: Creator | JEFE_AREA | ADMIN only.
    expect((await call('DELETE', `/api/v1/tasks/${task.id}`, { token: s.mkt.user.token })).status).toBe(403);
    expect((await call('DELETE', `/api/v1/tasks/${task.id}`, { token: s.mkt.jefe.token })).status).toBe(200);

    expect(await listIds(s.mkt.user.token)).toEqual([]);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { files: true } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.files[0]!.deletedAt).not.toBeNull();
  });
});
