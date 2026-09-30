import ExcelJS from 'exceljs';
import { prisma } from '../../src/lib/prisma';
import { addDays, localDay, mondayOf } from '../../src/lib/week';
import { createTask, seedWorkspace, WORKSPACE_TZ, type Seed } from './fixtures';
import { app, call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});
afterAll(() => prisma.$disconnect());

describe('workspace settings', () => {
  it('members read it; only an ADMIN changes it, with validation and an audit entry', async () => {
    const read = await call('GET', '/api/v1/workspace', { token: s.mkt.user.token });
    expect(read.body.workspace).toMatchObject({ name: 'Central Partner', timezone: 'America/Lima', contactEmail: null, primaryColor: '#2563EB' });

    const body = { name: 'Central Partner SAC', contactEmail: 'Director@Central.com', timezone: 'America/Bogota', primaryColor: '#3182ce' };
    expect((await call('PATCH', '/api/v1/workspace', { token: s.mkt.jefe.token, body })).status).toBe(403);
    const res = await call('PATCH', '/api/v1/workspace', { token: s.admin.token, body });
    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({ name: 'Central Partner SAC', contactEmail: 'director@central.com', timezone: 'America/Bogota', primaryColor: '#3182CE' });

    // The name and color are the branding everyone sees.
    const branding = await call('GET', `/api/v1/workspaces/${s.workspaceId}/branding`, { token: s.mkt.user.token });
    expect(branding.body.branding).toMatchObject({ workspaceName: 'Central Partner SAC', colors: { primary: '#3182CE' } });
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'WORKSPACE_SETTINGS_UPDATED' } });
    expect(log.changes).toMatchObject({ timezone: { old: 'America/Lima', new: 'America/Bogota' } });

    for (const bad of [{ contactEmail: 'no-es-email' }, { timezone: 'Lima' }, { primaryColor: 'blue' }, { name: '' }, {}]) {
      expect((await call('PATCH', '/api/v1/workspace', { token: s.admin.token, body: bad })).status).toBe(422);
    }
  });
});

describe('permissions', () => {
  it('shows the fixed role matrix and each area head’s settings (ADMIN only)', async () => {
    expect((await call('GET', '/api/v1/permissions', { token: s.mkt.jefe.token })).status).toBe(403);
    const res = await call('GET', '/api/v1/permissions', { token: s.admin.token });
    expect(res.body.roles.map((r: { role: string }) => r.role)).toEqual(['ADMIN', 'JEFE_AREA', 'USER', 'VIEWER']);
    const jefe = res.body.roles.find((r: { role: string }) => r.role === 'JEFE_AREA');
    expect(jefe.permissions.find((p: { key: string }) => p.key === 'see_other_departments').granted).toBe('configurable');
    expect(res.body.jefes.map((j: { id: string }) => j.id).sort()).toEqual([s.fin.jefe.id, s.mkt.jefe.id, s.mkt.jefeNoGrant.id].sort());
  });

  it('grants a head visibility of other areas and task creation, effective immediately', async () => {
    const finTask = await createTask(s.fin.jefe.token, { title: 'Cierre' });
    expect((await call('GET', `/api/v1/tasks/${finTask.id}`, { token: s.mkt.jefeNoGrant.token })).status).toBe(404);
    expect((await call('POST', '/api/v1/tasks', { token: s.mkt.jefeNoGrant.token, body: { title: 'X' } })).status).toBe(403);

    const res = await call('PATCH', '/api/v1/permissions/JEFE_AREA', {
      token: s.admin.token,
      body: { userId: s.mkt.jefeNoGrant.id, canCreateTasks: true, visibleDepartmentIds: [s.finanzas, s.marketing] },
    });
    expect(res.status).toBe(200);
    // Their own department is implicit and not stored.
    expect(res.body.jefes.find((j: { id: string }) => j.id === s.mkt.jefeNoGrant.id)).toMatchObject({ canCreateTasks: true, visibleDepartmentIds: [s.finanzas] });

    expect((await call('GET', `/api/v1/tasks/${finTask.id}`, { token: s.mkt.jefeNoGrant.token })).status).toBe(200);
    expect((await call('POST', '/api/v1/tasks', { token: s.mkt.jefeNoGrant.token, body: { title: 'X' } })).status).toBe(201);
    // Visibility is read-only: still can't edit Finanzas.
    expect((await call('PATCH', `/api/v1/tasks/${finTask.id}`, { token: s.mkt.jefeNoGrant.token, body: { title: 'Y' } })).status).toBe(403);
    expect(await prisma.activityLog.count({ where: { action: 'PERMISSIONS_UPDATED', entityId: s.mkt.jefeNoGrant.id } })).toBe(1);
  });

  it('only area heads are configurable', async () => {
    const other = await call('PATCH', '/api/v1/permissions/USER', { token: s.admin.token, body: { userId: s.mkt.user.id, canCreateTasks: true } });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('ROLE_NOT_CONFIGURABLE');
    const notJefe = await call('PATCH', '/api/v1/permissions/JEFE_AREA', { token: s.admin.token, body: { userId: s.mkt.user.id, canCreateTasks: true } });
    expect(notJefe.status).toBe(404);
    const badDept = await call('PATCH', '/api/v1/permissions/JEFE_AREA', {
      token: s.admin.token,
      body: { userId: s.mkt.jefe.id, visibleDepartmentIds: [crypto.randomUUID()] },
    });
    expect(badDept.status).toBe(422);
  });
});

describe('users (back office)', () => {
  it('POST /users invites and returns the link; validates email, role and department', async () => {
    const res = await call('POST', '/api/v1/users', { token: s.admin.token, body: { email: 'nuevo@empresa.com', role: 'USER', departmentId: s.marketing } });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(/\/accept-invite\?token=/);
    expect((await call('POST', '/api/v1/users', { token: s.admin.token, body: { email: 'ana.mkt@empresa.com', role: 'USER', departmentId: s.marketing } })).status).toBe(409);
    expect((await call('POST', '/api/v1/users', { token: s.admin.token, body: { email: 'x@empresa.com', role: 'SUPERUSER', departmentId: s.marketing } })).status).toBe(422);
    expect((await call('POST', '/api/v1/users', { token: s.admin.token, body: { email: 'x@empresa.com', role: 'USER', departmentId: crypto.randomUUID() } })).status).toBe(422);
    expect((await call('POST', '/api/v1/users', { token: s.mkt.jefe.token, body: { email: 'x@empresa.com', role: 'USER', departmentId: s.marketing } })).status).toBe(403);
  });

  it('deactivating is a soft delete and can be undone', async () => {
    expect((await call('DELETE', `/api/v1/users/${s.mkt.user.id}`, { token: s.admin.token })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.mkt.user.id } })).deletedAt).not.toBeNull();
    const deactivated = await call('GET', '/api/v1/users?status=deleted', { token: s.admin.token });
    expect(deactivated.body.data.map((u: { id: string }) => u.id)).toEqual([s.mkt.user.id]);
    expect((await call('POST', `/api/v1/users/${s.mkt.user.id}/restore`, { token: s.admin.token })).status).toBe(200);
  });
});

describe('audit logs', () => {
  it('lists newest first with filters, paging and Spanish labels (ADMIN only)', async () => {
    await createTask(s.mkt.jefe.token, { title: 'Informe' });
    await call('POST', '/api/v1/users', { token: s.admin.token, body: { email: 'nuevo@empresa.com', role: 'USER', departmentId: s.marketing } });

    expect((await call('GET', '/api/v1/audit-logs', { token: s.mkt.jefe.token })).status).toBe(403);
    const all = await call('GET', '/api/v1/audit-logs?limit=2', { token: s.admin.token });
    expect(all.body).toMatchObject({ page: 1, limit: 2 });
    expect(all.body.total).toBeGreaterThan(2);
    expect(all.body.data[0]).toMatchObject({ action: 'USER_INVITED', actionLabel: 'Invitó usuario', entityLabel: 'nuevo@empresa.com', user: { id: s.admin.id } });

    const created = await call('GET', `/api/v1/audit-logs?action=TASK_CREATED&userId=${s.mkt.jefe.id}`, { token: s.admin.token });
    expect(created.body.data.map((l: { entityLabel: string }) => l.entityLabel)).toEqual(['Informe']);
    const bySpanish = await call('GET', `/api/v1/audit-logs?search=${encodeURIComponent('creó tarea')}`, { token: s.admin.token });
    expect(bySpanish.body.data.every((l: { action: string }) => l.action === 'TASK_CREATED')).toBe(true);

    const today = localDay(new Date(), WORKSPACE_TZ);
    expect((await call('GET', `/api/v1/audit-logs?from=${today}&to=${today}`, { token: s.admin.token })).body.total).toBe(all.body.total);
    expect((await call('GET', `/api/v1/audit-logs?to=${addDays(today, -1)}`, { token: s.admin.token })).body.total).toBe(0);
    expect((await call('GET', '/api/v1/audit-logs?action=drop table', { token: s.admin.token })).status).toBe(422);
  });

  it('exports CSV (formula-safe) and Excel', async () => {
    await createTask(s.mkt.jefe.token, { title: '=HYPERLINK("http://evil")' });
    const csv = await app.request('/api/v1/audit-logs/export?format=csv&action=TASK_CREATED', { headers: { authorization: `Bearer ${s.admin.token}` } });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await csv.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, for Excel
    const text = new TextDecoder().decode(bytes);
    expect(text.split('\r\n')[0]).toBe('Fecha,Usuario,Email,Acción,Código,Entidad,Detalle,Cambios,IP');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);

    const xlsx = await app.request('/api/v1/audit-logs/export?format=xlsx', { headers: { authorization: `Bearer ${s.admin.token}` } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await xlsx.arrayBuffer());
    expect(wb.getWorksheet('Auditoría')!.getRow(1).values).toEqual(expect.arrayContaining(['Fecha', 'Usuario', 'Acción']));
  });
});

describe('week management', () => {
  it('lists archived weeks with their closing numbers, and exports one to Excel', async () => {
    const monday = addDays(mondayOf(new Date(), WORKSPACE_TZ), -7);
    const week = (await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: monday } })).body.week;
    await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });

    const list = await call('GET', '/api/v1/weeks/archived', { token: s.admin.token });
    expect(list.body.data).toEqual([expect.objectContaining({ id: week.id, status: 'ARCHIVED', archivedBy: { id: s.admin.id, displayName: 'director' } })]);

    const file = await app.request(`/api/v1/weeks/${week.id}/export`, { method: 'POST', headers: { authorization: `Bearer ${s.admin.token}` } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain(`DashboardCentralPartner_Week${week.weekNumber}.xlsx`);
    expect((await app.request(`/api/v1/weeks/${week.id}/export`, { method: 'POST', headers: { authorization: `Bearer ${s.mkt.jefe.token}` } })).status).toBe(403);
  });
});
