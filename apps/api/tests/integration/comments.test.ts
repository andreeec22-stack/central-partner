import { prisma } from '../../src/lib/prisma';
import { flushNotifications } from '../../src/modules/notifications/notify.service';
import { setWhatsAppTransport } from '../../src/modules/notifications/whatsapp.service';
import { createTask, seedWorkspace, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;
const sent: { to: string; body: string }[] = [];

// An Etc/GMT zone where it is currently `hour`:00-ish, so the 07–21 WhatsApp
// window is deterministic whatever time the suite runs.
function zoneWhereItIs(hour: number) {
  let offset = hour - new Date().getUTCHours();
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`; // POSIX signs are inverted
}

beforeAll(() => setWhatsAppTransport({ send: async (to, body) => (sent.push({ to, body }), { id: `SM${sent.length}` }) }));
afterAll(() => setWhatsAppTransport(null));

beforeEach(async () => {
  await resetDatabase();
  sent.length = 0;
  s = await seedWorkspace();
});

const comment = (token: string, taskId: string, content: string) =>
  call('POST', `/api/v1/tasks/${taskId}/comments`, { token, body: { content } });

async function enableWhatsApp(userId: string, timezone = zoneWhereItIs(12)) {
  await prisma.user.update({
    where: { id: userId },
    data: { phoneNumber: '+51999123456', timezone, notificationPrefs: { update: { enableWhatsApp: true } } },
  });
}

describe('comments', () => {
  it('creates, lists newest first, edits and soft-deletes', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Campaña', assignedTo: s.mkt.user.id });
    const first = await comment(s.mkt.user.token, task.id, 'Primer avance');
    expect(first.status).toBe(201);
    expect(first.body.comment).toMatchObject({ content: 'Primer avance', userId: s.mkt.user.id, mentions: [] });
    await comment(s.mkt.jefe.token, task.id, 'Segundo');

    const list = await call('GET', `/api/v1/tasks/${task.id}/comments`, { token: s.mkt.viewer.token });
    expect(list.body.data.map((c: { content: string }) => c.content)).toEqual(['Segundo', 'Primer avance']);

    const edited = await call('PATCH', `/api/v1/tasks/${task.id}/comments/${first.body.comment.id}`, {
      token: s.mkt.user.token,
      body: { content: 'Primer avance (corregido)' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.editedAt).not.toBeNull();

    expect((await call('DELETE', `/api/v1/tasks/${task.id}/comments/${first.body.comment.id}`, { token: s.mkt.user.token })).status).toBe(200);
    const after = await call('GET', `/api/v1/tasks/${task.id}/comments`, { token: s.mkt.user.token });
    expect(after.body.data).toHaveLength(1);
    const row = await prisma.comment.findUniqueOrThrow({ where: { id: first.body.comment.id } });
    expect(row.deletedAt).not.toBeNull();

    const actions = (await prisma.activityLog.findMany({ where: { entityId: task.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['COMMENT_ADDED', 'COMMENT_EDITED', 'COMMENT_DELETED']));
    const counts = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(counts.totalCommentsCount).toBe(1);
  });

  it('validates length and who may comment, edit and delete', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Campaña' });
    expect((await comment(s.mkt.user.token, task.id, '   ')).status).toBe(422);
    expect((await comment(s.mkt.user.token, task.id, 'x'.repeat(5001))).status).toBe(422);
    // VIEWERs read only; other departments can't even see the task.
    expect((await comment(s.mkt.viewer.token, task.id, 'hola')).status).toBe(403);
    expect((await comment(s.fin.user.token, task.id, 'hola')).status).toBe(404);

    const mine = await comment(s.mkt.user.token, task.id, 'mío');
    const url = `/api/v1/tasks/${task.id}/comments/${mine.body.comment.id}`;
    expect((await call('PATCH', url, { token: s.mkt.user2.token, body: { content: 'ajeno' } })).status).toBe(403);
    expect((await call('DELETE', url, { token: s.mkt.jefe.token })).status).toBe(403);
    expect((await call('DELETE', url, { token: s.admin.token })).status).toBe(200);
  });

  it("a JEFE_AREA's visibility grant is read-only for comments", async () => {
    await prisma.departmentVisibility.create({
      data: { workspaceId: s.workspaceId, jefeAreaId: s.mkt.jefe.id, visibleDepartmentIds: [s.finanzas] },
    });
    const task = await createTask(s.fin.jefe.token, { title: 'Cierre' });
    expect((await call('GET', `/api/v1/tasks/${task.id}/comments`, { token: s.mkt.jefe.token })).status).toBe(200);
    expect((await comment(s.mkt.jefe.token, task.id, 'opino')).status).toBe(403);
  });

  it('caps comments per task', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Hilo largo' });
    await prisma.comment.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({ workspaceId: s.workspaceId, taskId: task.id, authorId: s.mkt.user.id, content: `c${i}` })),
    });
    const res = await comment(s.mkt.user.token, task.id, 'uno más');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COMMENT_LIMIT_REACHED');
  });
});

describe('mentions and notifications', () => {
  it('resolves @handles among people who can see the task and notifies them in-app', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Reportaje', assignedTo: s.mkt.user.id });
    // luis.mkt is in Marketing; carla.fin can't see the task; @nadie doesn't exist.
    const res = await comment(s.mkt.user.token, task.id, 'Listo @luis.mkt, revisa. cc @carla.fin @nadie @ana.mkt');
    expect(res.status).toBe(201);
    expect(res.body.comment.mentions).toEqual([s.mkt.user2.id]); // self-mention dropped too
    expect(res.body.comment.mentionedUsers[0]).toMatchObject({ id: s.mkt.user2.id, handle: 'luis.mkt' });

    const notes = await prisma.notification.findMany({ where: { taskId: task.id, type: 'MENTIONED' } });
    expect(notes.map((n) => n.userId)).toEqual([s.mkt.user2.id]);
    expect(notes[0]!.title).toContain('te mencionó en "Reportaje"');
    expect(await prisma.notification.count({ where: { userId: s.fin.user.id } })).toBe(0);
  });

  it('notifies earlier commenters of a reply, once', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Brief' });
    await comment(s.mkt.user.token, task.id, 'Arranco');
    await comment(s.mkt.user2.token, task.id, 'Yo también');
    await comment(s.mkt.jefe.token, task.id, 'Perfecto @luis.mkt');

    const forAna = await prisma.notification.findMany({ where: { userId: s.mkt.user.id, taskId: task.id } });
    expect(forAna.map((n) => n.type)).toEqual(['COMMENT_REPLY', 'COMMENT_REPLY']);
    // Luis was mentioned in the jefe's comment: that one comes as MENTIONED only.
    const forLuis = await prisma.notification.findMany({ where: { userId: s.mkt.user2.id, taskId: task.id } });
    expect(forLuis.map((n) => n.type)).toEqual(['MENTIONED']);
  });

  it('only notifies mentions added by an edit', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Brief' });
    const c = await comment(s.mkt.jefe.token, task.id, 'Hola @ana.mkt');
    await call('PATCH', `/api/v1/tasks/${task.id}/comments/${c.body.comment.id}`, {
      token: s.mkt.jefe.token,
      body: { content: 'Hola @ana.mkt y @luis.mkt' },
    });
    expect(await prisma.notification.count({ where: { userId: s.mkt.user.id, type: 'MENTIONED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: s.mkt.user2.id, type: 'MENTIONED' } })).toBe(1);
  });

  it('lists mentionable people with their handles', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Brief' });
    const res = await call('GET', `/api/v1/tasks/${task.id}/mentionable`, { token: s.mkt.user.token });
    const handles = res.body.data.map((p: { handle: string }) => p.handle).sort();
    expect(handles).toEqual(['ana.mkt', 'director', 'jefe.mkt', 'lector.mkt', 'luis.mkt', 'subjefe.mkt']);
  });

  it('sends WhatsApp for mentions and assignments when enabled, rate-limited per task', async () => {
    await enableWhatsApp(s.mkt.user.id);
    const task = await createTask(s.mkt.jefe.token, { title: 'Pauta', assignedTo: s.mkt.user.id });
    await flushNotifications();
    await comment(s.mkt.jefe.token, task.id, '@ana.mkt mira esto');
    await flushNotifications();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('+51999123456');
    expect(sent[0]!.body).toContain('Nueva tarea asignada: "Pauta"');
    const logs = await prisma.whatsAppNotificationLog.findMany({ where: { userId: s.mkt.user.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => [l.type, l.status, l.reason])).toEqual([
      ['TASK_ASSIGNED', 'SENT', null],
      ['MENTIONED', 'SKIPPED', 'RATE_LIMITED'],
    ]);
    // In-app notifications are never rate-limited.
    expect(await prisma.notification.count({ where: { userId: s.mkt.user.id } })).toBe(2);
  });

  it('holds WhatsApp outside 07:00–21:00 and respects per-event opt-outs', async () => {
    await enableWhatsApp(s.mkt.user.id, zoneWhereItIs(23));
    await enableWhatsApp(s.mkt.user2.id);
    await prisma.userNotificationPreferences.update({ where: { userId: s.mkt.user2.id }, data: { whatsAppEvents: { MENTIONED: false } } });

    const task = await createTask(s.mkt.jefe.token, { title: 'Nocturna' });
    await comment(s.mkt.jefe.token, task.id, '@ana.mkt @luis.mkt');
    await flushNotifications();

    expect(sent).toHaveLength(0);
    const logs = await prisma.whatsAppNotificationLog.findMany();
    expect(logs.map((l) => [l.userId, l.reason])).toEqual([[s.mkt.user.id, 'QUIET_HOURS']]);
  });

  it('logs a failed send without failing the comment', async () => {
    setWhatsAppTransport({ send: async () => Promise.reject(new Error('Twilio 400: invalid number')) });
    try {
      await enableWhatsApp(s.mkt.user.id);
      const task = await createTask(s.mkt.jefe.token, { title: 'X' });
      expect((await comment(s.mkt.jefe.token, task.id, '@ana.mkt')).status).toBe(201);
      await flushNotifications();
      const log = await prisma.whatsAppNotificationLog.findFirstOrThrow();
      expect(log).toMatchObject({ status: 'FAILED', reason: 'Twilio 400: invalid number' });
    } finally {
      setWhatsAppTransport({ send: async (to, body) => (sent.push({ to, body }), { id: 'x' }) });
    }
  });
});

describe('task detail', () => {
  it('returns comments, files, activity and the caller permissions', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Detalle', assignedTo: s.mkt.user.id });
    await comment(s.mkt.user.token, task.id, 'hola');

    const asUser = await call('GET', `/api/v1/tasks/${task.id}`, { token: s.mkt.user.token });
    expect(asUser.status).toBe(200);
    expect(asUser.body.comments).toHaveLength(1);
    expect(asUser.body.files).toEqual([]);
    expect(asUser.body.activity[0]).toMatchObject({ action: 'COMMENT_ADDED', taskId: task.id, user: { id: s.mkt.user.id } });
    expect(asUser.body.permissions).toEqual({ canEdit: true, canComment: true, canAddFiles: true, canDelete: false, weekOpen: true });

    const asViewer = await call('GET', `/api/v1/tasks/${task.id}`, { token: s.mkt.viewer.token });
    expect(asViewer.body.permissions).toEqual({ canEdit: false, canComment: false, canAddFiles: false, canDelete: false, weekOpen: true });
  });
});
