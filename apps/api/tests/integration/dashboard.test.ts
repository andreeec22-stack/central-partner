import { prisma } from '../../src/lib/prisma';
import { createTask, dueAt, seedWorkspace, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});

afterAll(() => prisma.$disconnect());

describe('GET /dashboard', () => {
  it('summarizes status, semaphore and departments within the caller’s scope', async () => {
    const a = await createTask(s.mkt.jefe.token, { title: 'A', assignedTo: s.mkt.user.id, dueDate: dueAt(-1) });
    const b = await createTask(s.mkt.jefe.token, { title: 'B', assignedTo: s.mkt.user.id, dueDate: dueAt(-1) });
    await createTask(s.fin.jefe.token, { title: 'F', dueDate: dueAt(1) });
    await call('PATCH', `/api/v1/tasks/${a.id}`, { token: s.mkt.user.token, body: { progress: 100 } });
    await call('PATCH', `/api/v1/tasks/${b.id}`, { token: s.mkt.user.token, body: { status: 'BLOCKED', blockReason: 'Falta aprobación' } });

    const admin = (await call('GET', '/api/v1/dashboard', { token: s.admin.token })).body;
    expect(admin.summary).toEqual({ totalTasks: 3, todoCount: 1, inProgressCount: 0, blockedCount: 1, completedCount: 1 });
    // By date: A is done, B's day passed, F is due tomorrow.
    expect(admin.semaphore).toEqual({ GREEN: 1, YELLOW: 0, RED: 1, GRAY: 1 });
    expect(admin.byDepartment.map((d: { name: string; totalTasks: number }) => [d.name, d.totalTasks])).toEqual([
      ['Finanzas', 1],
      ['Marketing', 2],
    ]);

    const user = (await call('GET', '/api/v1/dashboard', { token: s.mkt.user.token })).body;
    expect(user.summary.totalTasks).toBe(2);
    expect(user.byDepartment.map((d: { name: string }) => d.name)).toEqual(['Marketing']);
    // Activity never mentions tasks outside the scope.
    expect(user.recentActivity.every((e: { task: { departmentId: string } }) => e.task.departmentId === s.marketing)).toBe(true);
    expect(user.recentActivity[0]).toMatchObject({ action: 'TASK_BLOCKED', task: { title: 'B' } });

    expect((await call('GET', `/api/v1/dashboard?departmentId=${s.finanzas}`, { token: s.mkt.user.token })).status).toBe(403);
  });
});
