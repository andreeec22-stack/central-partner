import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { io as connect, type Socket } from 'socket.io-client';
import { prisma } from '../../src/lib/prisma';
import { setRealtimeServer } from '../../src/lib/realtime';
import { attachSocketServer } from '../../src/realtime/socket-server';
import { addDays, mondayOf } from '../../src/lib/week';
import { createTask, dueAt, seedWorkspace, WORKSPACE_TZ, type Seed } from './fixtures';
import { app, call, resetDatabase } from './helpers';

let server: HttpServer;
let url: string;
let s: Seed;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = serve({ fetch: app.fetch, port: 0 }) as HttpServer;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  attachSocketServer(server);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setRealtimeServer(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
});

afterEach(() => {
  while (sockets.length) sockets.pop()!.disconnect();
});

// Resolves once the server has put the socket in its rooms.
function open(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    socket.once('ready', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function record(socket: Socket, event: string) {
  const received: any[] = [];
  socket.on(event, (payload) => received.push(payload));
  return received;
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('socket authentication', () => {
  it('rejects missing or invalid tokens', async () => {
    await expect(open('')).rejects.toThrow('UNAUTHORIZED');
    await expect(open('not-a-jwt')).rejects.toThrow('TOKEN_INVALID');
  });

  it('disconnects the session’s sockets on logout', async () => {
    const socket = await open(s.mkt.user.token);
    const closed = new Promise((resolve) => socket.once('disconnect', resolve));
    await call('POST', '/api/v1/auth/logout', { token: s.mkt.user.token });
    await expect(closed).resolves.toBe('io server disconnect');
  });
});

describe('task events reach exactly the people who can see the task', () => {
  it('task:created goes to the department and ADMINs only', async () => {
    const [mkt, fin, admin] = await Promise.all([open(s.mkt.user2.token), open(s.fin.user.token), open(s.admin.token)]);
    const got = { mkt: record(mkt, 'task:created'), fin: record(fin, 'task:created'), admin: record(admin, 'task:created') };

    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Campaña' });
    await settle();

    expect(got.mkt).toHaveLength(1);
    expect(got.mkt[0]).toMatchObject({ taskId: task.id, title: 'Campaña', departmentId: s.marketing, sourceType: 'MANUAL' });
    expect(got.admin).toHaveLength(1);
    expect(got.fin).toHaveLength(0);
  });

  it('progress, blocked and completed events carry their payloads', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Reporte', dueDate: dueAt(1) });
    const jefe = await open(s.mkt.jefe.token);
    const progress = record(jefe, 'task:progress');
    const blocked = record(jefe, 'task:blocked');
    const completed = record(jefe, 'task:completed');
    const updated = record(jefe, 'task:updated');

    await call('PATCH', `/api/v1/tasks/${task.id}`, { token: s.mkt.user.token, body: { progress: 75 } });
    await call('PATCH', `/api/v1/tasks/${task.id}`, { token: s.mkt.user.token, body: { status: 'BLOCKED', blockReason: 'Falta arte' } });
    await call('PATCH', `/api/v1/tasks/${task.id}`, { token: s.mkt.user.token, body: { status: 'DONE' } });
    await settle();

    expect(progress.map((p) => [p.progress, p.semaphore])).toEqual([
      [75, 'GRAY'], // due tomorrow: not late yet
      [100, 'GREEN'],
    ]);
    expect(blocked).toEqual([expect.objectContaining({ taskId: task.id, reason: 'Falta arte', blockedByUserId: s.mkt.user.id })]);
    expect(completed).toEqual([expect.objectContaining({ taskId: task.id, onTime: true })]); // finished before its day
    expect(updated).toHaveLength(3);
    expect(updated[0].changes.progress).toEqual({ old: 0, new: 75 });
  });

  it('a JEFE_AREA granted visibility starts receiving after a role/visibility refresh', async () => {
    const jefe = await open(s.mkt.jefe.token);
    const created = record(jefe, 'task:created');

    await createTask(s.fin.jefe.token, { assignedTo: s.fin.user.id, title: 'Antes' });
    await settle();
    expect(created).toHaveLength(0);

    await prisma.departmentVisibility.create({
      data: { workspaceId: s.workspaceId, jefeAreaId: s.mkt.jefe.id, visibleDepartmentIds: [s.finanzas] },
    });
    // The visibility endpoint (Days 9–10) will trigger this refresh itself.
    const { refreshUserRooms } = await import('../../src/realtime/socket-server');
    await refreshUserRooms(s.mkt.jefe.id);

    await createTask(s.fin.jefe.token, { assignedTo: s.fin.user.id, title: 'Después' });
    await settle();
    expect(created.map((e) => e.title)).toEqual(['Después']);
  });

  it('moving a task away tells the old department it left their view — without its contents', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Mover' });
    const [mkt, admin] = await Promise.all([open(s.mkt.user2.token), open(s.admin.token)]);
    const mktUpdates = record(mkt, 'task:updated');
    const adminUpdates = record(admin, 'task:updated');
    await call('PATCH', `/api/v1/tasks/${task.id}`, { token: s.admin.token, body: { departmentId: s.finanzas, assignedTo: null } });
    await settle();
    expect(mktUpdates).toEqual([{ taskId: task.id, removed: true }]);
    expect(adminUpdates).toHaveLength(1);
    expect(adminUpdates[0].changes.departmentId).toEqual({ old: s.marketing, new: s.finanzas });
  });
});

describe('collaboration events', () => {
  it('comment events reach the task audience and mentions reach the person', async () => {
    const task = await createTask(s.mkt.jefe.token, { assignedTo: s.mkt.user.id, title: 'Brief' });
    const [luis, fin, admin] = await Promise.all([open(s.mkt.user2.token), open(s.fin.user.token), open(s.admin.token)]);
    const comments = { luis: record(luis, 'comment:created'), fin: record(fin, 'comment:created'), admin: record(admin, 'comment:created') };
    const notes = { luis: record(luis, 'notification:created'), admin: record(admin, 'notification:created') };

    await call('POST', `/api/v1/tasks/${task.id}/comments`, { token: s.mkt.user.token, body: { content: 'Listo @luis.mkt' } });
    await settle();

    expect(comments.luis[0]).toMatchObject({ taskId: task.id, comment: { content: 'Listo @luis.mkt', mentions: [s.mkt.user2.id] } });
    expect(comments.admin).toHaveLength(1);
    expect(comments.fin).toHaveLength(0);
    expect(notes.luis[0].notification).toMatchObject({ type: 'MENTIONED', taskId: task.id, fromUser: { id: s.mkt.user.id } });
    expect(notes.admin).toHaveLength(0);
  });

  it('branding updates reach the whole workspace', async () => {
    const [user, fin] = await Promise.all([open(s.mkt.user.token), open(s.fin.user.token)]);
    const got = [record(user, 'branding:updated'), record(fin, 'branding:updated')];
    await call('PATCH', `/api/v1/workspaces/${s.workspaceId}/branding`, { token: s.admin.token, body: { colors: { primary: '#123456' } } });
    await settle();
    for (const events of got) expect(events[0].branding.colors.primary).toBe('#123456');
  });
});

describe('weekly cycle events', () => {
  // Last week: already past its Saturday 10:00, so it can be closed any day.
  const lastWeek = async () => {
    const monday = addDays(mondayOf(new Date(), WORKSPACE_TZ), -7);
    return (await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: monday } })).body.week as { id: string };
  };

  it('KPI changes reach the area and ADMINs; closing a week reaches everyone', async () => {
    const week = await lastWeek();
    const [mkt, fin, admin] = await Promise.all([open(s.mkt.user.token), open(s.fin.user.token), open(s.admin.token)]);
    const kpi = { mkt: record(mkt, 'kpi:changed'), fin: record(fin, 'kpi:changed'), admin: record(admin, 'kpi:changed') };
    const closed = { mkt: record(mkt, 'week:closed'), fin: record(fin, 'week:closed') };

    await call('POST', `/api/v1/departments/${s.marketing}/kpis`, { token: s.mkt.jefe.token, body: { weekId: week.id, title: 'Leads', target: 100 } });
    await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });
    await settle();

    expect(kpi.mkt).toEqual([{ departmentId: s.marketing, weekId: week.id }]);
    expect(kpi.admin).toHaveLength(1);
    expect(kpi.fin).toHaveLength(0);
    expect(closed.mkt[0]).toMatchObject({ week: { id: week.id, status: 'ARCHIVED' }, carriedTasks: expect.any(Number) });
    expect(closed.fin).toHaveLength(1);
  });

  it('two simultaneous closings archive the week once', async () => {
    const week = await lastWeek();
    const results = await Promise.all([
      call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } }),
      call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.weeklyArchive.count({ where: { weekId: week.id } })).toBe(1);
  });
});
