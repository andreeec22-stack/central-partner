import { prisma } from '../../src/lib/prisma';
import { createTask, seedWorkspace, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});

afterAll(() => prisma.$disconnect());

describe('departments', () => {
  it('only ADMIN can create, update or delete', async () => {
    for (const actor of [s.mkt.jefe, s.mkt.user, s.mkt.viewer]) {
      expect((await call('POST', '/api/v1/departments', { token: actor.token, body: { name: 'X' } })).status).toBe(403);
      expect((await call('PATCH', `/api/v1/departments/${s.marketing}`, { token: actor.token, body: { name: 'X' } })).status).toBe(403);
      expect((await call('DELETE', `/api/v1/departments/${s.marketing}`, { token: actor.token })).status).toBe(403);
    }
  });

  it('rejects duplicate names case-insensitively and validates colors', async () => {
    const dup = await call('POST', '/api/v1/departments', { token: s.admin.token, body: { name: 'marketing' } });
    expect(dup.status).toBe(409);
    const badColor = await call('POST', '/api/v1/departments', { token: s.admin.token, body: { name: 'RRHH', color: 'red' } });
    expect(badColor.status).toBe(422);
  });

  it('sets a head and reports member counts', async () => {
    const res = await call('PATCH', `/api/v1/departments/${s.marketing}`, {
      token: s.admin.token,
      body: { headId: s.mkt.jefe.id, color: '#10B981' },
    });
    expect(res.status).toBe(200);
    expect(res.body.department).toMatchObject({ headId: s.mkt.jefe.id, color: '#10B981', usersCount: 4 });
    const log = await prisma.activityLog.findFirst({ where: { action: 'DEPARTMENT_UPDATED', entityId: s.marketing } });
    expect(log?.changes).toMatchObject({ headId: { old: null, new: s.mkt.jefe.id } });
  });

  it('lists only departments the caller may see', async () => {
    const names = async (token: string) =>
      (await call('GET', '/api/v1/departments', { token })).body.data.map((d: { name: string }) => d.name);
    expect(await names(s.admin.token)).toEqual(['Finanzas', 'Marketing']);
    expect(await names(s.mkt.user.token)).toEqual(['Marketing']);
    expect(await names(s.mkt.jefe.token)).toEqual(['Marketing']);

    await prisma.departmentVisibility.create({
      data: { workspaceId: s.workspaceId, jefeAreaId: s.mkt.jefe.id, visibleDepartmentIds: [s.finanzas] },
    });
    expect(await names(s.mkt.jefe.token)).toEqual(['Finanzas', 'Marketing']);
  });

  it('refuses to delete a department with active tasks, then soft-deletes and unassigns members', async () => {
    const task = await createTask(s.mkt.user.token, { title: 'Campaña octubre' });
    const blocked = await call('DELETE', `/api/v1/departments/${s.marketing}`, { token: s.admin.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DEPARTMENT_NOT_EMPTY');

    await call('DELETE', `/api/v1/tasks/${task.id}`, { token: s.admin.token });
    expect((await call('DELETE', `/api/v1/departments/${s.marketing}`, { token: s.admin.token })).status).toBe(200);

    const dept = await prisma.department.findUniqueOrThrow({ where: { id: s.marketing } });
    expect(dept.deletedAt).not.toBeNull();
    const member = await prisma.user.findUniqueOrThrow({ where: { id: s.mkt.user.id } });
    expect(member.departmentId).toBeNull();
  });

  it('returns 404 for malformed and foreign ids', async () => {
    expect((await call('PATCH', '/api/v1/departments/not-a-uuid', { token: s.admin.token, body: { name: 'Y' } })).status).toBe(404);
    expect(
      (await call('PATCH', '/api/v1/departments/00000000-0000-4000-8000-000000000000', { token: s.admin.token, body: { name: 'Y' } })).status,
    ).toBe(404);
  });
});
