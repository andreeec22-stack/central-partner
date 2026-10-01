import { prisma } from '../../src/lib/prisma';
import { createTask, seedWorkspace, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});
afterAll(() => prisma.$disconnect());

const patch = (token: string, id: string, body: Record<string, unknown>) => call('PATCH', `/api/v1/tasks/${id}`, { token, body });

describe('task edit conflicts (optimistic concurrency, first write wins)', () => {
  it('refuses a save based on an outdated version with 409 TASK_CONFLICT', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Campaña', assignedTo: s.mkt.user.id });
    const seen = task.updatedAt;

    const first = await patch(s.mkt.jefe.token, task.id, { title: 'Campaña Q4', expectedUpdatedAt: seen });
    expect(first.status).toBe(200);

    const second = await patch(s.mkt.user.token, task.id, { progress: 50, expectedUpdatedAt: seen });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('TASK_CONFLICT');
    expect(second.body.error.details.updatedAt).toBe(first.body.task.updatedAt);

    // The first write stands; nothing of the second was applied.
    const now = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(now).toMatchObject({ title: 'Campaña Q4', progress: 0 });

    // Based on the current version, it goes through.
    expect((await patch(s.mkt.user.token, task.id, { progress: 50, expectedUpdatedAt: first.body.task.updatedAt })).status).toBe(200);
  });

  it('two saves from the same version at the same time: exactly one wins', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Reporte', assignedTo: s.mkt.user.id });
    const results = await Promise.all([
      patch(s.mkt.jefe.token, task.id, { title: 'Por el jefe', expectedUpdatedAt: task.updatedAt }),
      patch(s.mkt.user.token, task.id, { progress: 75, expectedUpdatedAt: task.updatedAt }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const now = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const winner = results.find((r) => r.status === 200)!;
    expect(now.updatedAt.toISOString()).toBe(winner.body.task.updatedAt);
    expect(now.title === 'Por el jefe').not.toBe(now.progress === 75); // only one of the two changes landed
  });

  it('without expectedUpdatedAt it behaves as before (last write)', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Libre' });
    expect((await patch(s.mkt.jefe.token, task.id, { title: 'A' })).status).toBe(200);
    expect((await patch(s.mkt.jefe.token, task.id, { title: 'B' })).status).toBe(200);
    expect((await patch(s.mkt.jefe.token, task.id, { expectedUpdatedAt: task.updatedAt })).status).toBe(422); // a version alone is not an update
  });
});
