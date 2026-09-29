import { drainTestOutbox } from '../../src/lib/mailer';
import { prisma } from '../../src/lib/prisma';
import { seedWorkspace, type Seed } from './fixtures';
import { call, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
  drainTestOutbox();
});

afterAll(() => prisma.$disconnect());

function tokenFromMail() {
  const mails = drainTestOutbox();
  expect(mails).toHaveLength(1);
  return { mail: mails[0]!, token: decodeURIComponent(/token=([^\s]+)/.exec(mails[0]!.text)![1]!) };
}

describe('invite flow (register → invite → accept → login)', () => {
  it('lets an invited person join with the invited role and department', async () => {
    const invite = await call('POST', '/api/v1/users/invite', {
      token: s.admin.token,
      body: { email: 'Nuevo@Empresa.com', role: 'USER', departmentId: s.marketing, phoneNumber: '+573001234567' },
    });
    expect(invite.status).toBe(201);
    const hoursValid = (new Date(invite.body.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hoursValid).toBeGreaterThan(23.9);
    expect(hoursValid).toBeLessThanOrEqual(24);

    const { mail, token } = tokenFromMail();
    expect(mail.to).toBe('nuevo@empresa.com');

    const lookup = await call('GET', `/api/v1/users/accept-invite?token=${encodeURIComponent(token)}`);
    expect(lookup.body).toMatchObject({ email: 'nuevo@empresa.com', role: 'USER', workspaceName: 'Central Partner' });

    const accepted = await call('POST', '/api/v1/users/accept-invite', {
      body: { token, password: 'mi-clave-123', displayName: 'Nuevo Usuario' },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({ role: 'USER', departmentId: s.marketing, phoneNumber: '+573001234567' });
    expect(accepted.body.accessToken).toEqual(expect.any(String));

    const again = await call('POST', '/api/v1/users/accept-invite', { body: { token, password: 'otra-clave-1', displayName: 'X' } });
    expect(again.status).toBe(422);

    const login = await call('POST', '/api/v1/auth/login', { body: { email: 'nuevo@empresa.com', password: 'mi-clave-123' } });
    expect(login.status).toBe(200);
  });

  it('expires invitations after 24 hours', async () => {
    await call('POST', '/api/v1/users/invite', { token: s.admin.token, body: { email: 'tarde@empresa.com', role: 'VIEWER', departmentId: s.finanzas } });
    const { token } = tokenFromMail();
    await prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await call('POST', '/api/v1/users/accept-invite', { body: { token, password: 'mi-clave-123', displayName: 'Tarde' } });
    expect(res.status).toBe(422);
  });

  it('a new invitation replaces the previous one', async () => {
    const body = { email: 'dos@empresa.com', role: 'USER', departmentId: s.marketing };
    await call('POST', '/api/v1/users/invite', { token: s.admin.token, body });
    const first = tokenFromMail().token;
    await call('POST', '/api/v1/users/invite', { token: s.admin.token, body });
    const second = tokenFromMail().token;
    expect((await call('POST', '/api/v1/users/accept-invite', { body: { token: first, password: 'mi-clave-123', displayName: 'D' } })).status).toBe(422);
    expect((await call('POST', '/api/v1/users/accept-invite', { body: { token: second, password: 'mi-clave-123', displayName: 'D' } })).status).toBe(201);
  });

  it('rejects inviting existing or deactivated members, and non-admin inviters', async () => {
    const existing = await call('POST', '/api/v1/users/invite', { token: s.admin.token, body: { email: 'ana.mkt@empresa.com', role: 'USER', departmentId: s.marketing } });
    expect(existing.body.error.code).toBe('USER_EXISTS');

    await call('DELETE', `/api/v1/users/${s.mkt.user.id}`, { token: s.admin.token });
    const deactivated = await call('POST', '/api/v1/users/invite', { token: s.admin.token, body: { email: 'ana.mkt@empresa.com', role: 'USER', departmentId: s.marketing } });
    expect(deactivated.body.error.code).toBe('USER_DEACTIVATED');

    const byJefe = await call('POST', '/api/v1/users/invite', { token: s.mkt.jefe.token, body: { email: 'z@empresa.com', role: 'USER', departmentId: s.marketing } });
    expect(byJefe.status).toBe(403);
  });

  it('requires a department for non-admin roles', async () => {
    const res = await call('POST', '/api/v1/users/invite', { token: s.admin.token, body: { email: 'sin@empresa.com', role: 'USER' } });
    expect(res.status).toBe(422);
  });
});

describe('updating users', () => {
  const profile = (actor: { id: string; token: string }, body: unknown, id = actor.id) =>
    call('PATCH', `/api/v1/users/${id}/profile`, { token: actor.token, body });

  it('people edit their own profile via /profile', async () => {
    const own = await profile(s.mkt.user, { displayName: 'Ana María', timezone: 'America/Bogota' });
    expect(own.status).toBe(200);
    expect(own.body.user).toMatchObject({ displayName: 'Ana María', timezone: 'America/Bogota' });
    expect((await profile(s.mkt.user, { timezone: 'Mars/Base' })).status).toBe(422);
    expect((await profile(s.mkt.user, { displayName: 'x' }, s.mkt.user2.id)).status).toBe(403);
  });

  it('nobody can change their own role, department or task permission', async () => {
    for (const body of [{ role: 'ADMIN' }, { departmentId: s.finanzas }, { canCreateTasks: true }]) {
      expect((await profile(s.mkt.jefeNoGrant, body)).status).toBe(403);
      // The admin endpoint is closed to non-admins too.
      expect((await call('PATCH', `/api/v1/users/${s.mkt.jefeNoGrant.id}`, { token: s.mkt.jefeNoGrant.token, body })).status).toBe(403);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: s.mkt.jefeNoGrant.id } });
    expect(row).toMatchObject({ role: 'JEFE_AREA', departmentId: s.marketing, canCreateTasks: false });
  });

  it('changing the login email needs the current password and a free address', async () => {
    expect((await profile(s.mkt.user, { email: 'ana.nueva@empresa.com' })).status).toBe(422);
    expect((await profile(s.mkt.user, { email: 'ana.nueva@empresa.com', currentPassword: 'incorrecta' })).status).toBe(422);
    const taken = await profile(s.mkt.user, { email: 'luis.mkt@empresa.com', currentPassword: 'secreto-123' });
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');
    const ok = await profile(s.mkt.user, { email: 'Ana.Nueva@empresa.com', currentPassword: 'secreto-123' });
    expect(ok.body.user.email).toBe('ana.nueva@empresa.com');
    expect((await call('POST', '/api/v1/auth/login', { body: { email: 'ana.nueva@empresa.com', password: 'secreto-123' } })).status).toBe(200);
  });

  it('role changes apply immediately to existing tokens', async () => {
    expect((await call('POST', '/api/v1/tasks', { token: s.mkt.viewer.token, body: { title: 'x' } })).status).toBe(403);
    await call('PATCH', `/api/v1/users/${s.mkt.viewer.id}`, { token: s.admin.token, body: { role: 'JEFE_AREA', canCreateTasks: true } });
    expect((await call('POST', '/api/v1/tasks', { token: s.mkt.viewer.token, body: { title: 'x' } })).status).toBe(201);
  });

  it('WhatsApp notifications need a phone number; quiet hours come in pairs', async () => {
    const noPhone = await call('PATCH', `/api/v1/users/${s.mkt.user.id}/profile`, {
      token: s.mkt.user.token,
      body: { notificationPreferences: { enableWhatsApp: true } },
    });
    expect(noPhone.status).toBe(422);

    const half = await call('PATCH', `/api/v1/users/${s.mkt.user.id}/profile`, {
      token: s.mkt.user.token,
      body: { notificationPreferences: { quietHoursStart: '22:00' } },
    });
    expect(half.status).toBe(422);

    const ok = await call('PATCH', `/api/v1/users/${s.mkt.user.id}/profile`, {
      token: s.mkt.user.token,
      body: {
        phoneNumber: '+573001112233',
        notificationPreferences: { enableWhatsApp: true, quietHoursStart: '21:00', quietHoursEnd: '07:00', whatsAppEvents: { KPI_REMINDER: false } },
      },
    });
    expect(ok.status).toBe(200);

    const prefs = await call('GET', `/api/v1/users/${s.mkt.user.id}/notification-preferences`, { token: s.mkt.user.token });
    expect(prefs.body).toMatchObject({ enableWhatsApp: true, quietHoursStart: '21:00', quietHoursEnd: '07:00', whatsAppEvents: { KPI_REMINDER: false } });
    expect((await call('GET', `/api/v1/users/${s.mkt.user.id}/notification-preferences`, { token: s.mkt.user2.token })).status).toBe(403);
  });

  it('protects the last administrator', async () => {
    const demote = await call('PATCH', `/api/v1/users/${s.admin.id}`, { token: s.admin.token, body: { role: 'USER' } });
    expect(demote.body.error.code).toBe('LAST_ADMIN');
    const self = await call('DELETE', `/api/v1/users/${s.admin.id}`, { token: s.admin.token });
    expect(self.body.error.code).toBe('CANNOT_DELETE_SELF');
  });

  it('hides phone numbers from other members', async () => {
    await prisma.user.update({ where: { id: s.mkt.user2.id }, data: { phoneNumber: '+573009998877' } });
    const list = await call('GET', '/api/v1/users', { token: s.mkt.user.token });
    const luis = list.body.data.find((u: { id: string }) => u.id === s.mkt.user2.id);
    expect(luis.phoneNumber).toBeUndefined();
    const asAdmin = await call('GET', `/api/v1/users?search=luis`, { token: s.admin.token });
    expect(asAdmin.body.data[0].phoneNumber).toBe('+573009998877');
  });
});

describe('JEFE_AREA task-creation permission (can_create_tasks)', () => {
  async function inviteAndAccept(body: Record<string, unknown>) {
    const inv = await call('POST', '/api/v1/users/invite', { token: s.admin.token, body: { departmentId: s.marketing, ...body } });
    expect(inv.status).toBe(201);
    const { token } = tokenFromMail();
    const acc = await call('POST', '/api/v1/users/accept-invite', { body: { token, password: 'mi-clave-123', displayName: 'Nuevo' } });
    expect(acc.status).toBe(201);
    return acc.body;
  }

  it('an invited JEFE_AREA with the box checked can create tasks', async () => {
    const jefe = await inviteAndAccept({ email: 'jefe.nuevo@empresa.com', role: 'JEFE_AREA', canCreateTasks: true });
    expect(jefe.user.canCreateTasks).toBe(true);
    expect((await call('POST', '/api/v1/tasks', { token: jefe.accessToken, body: { title: 'Primera' } })).status).toBe(201);
  });

  it('an invited JEFE_AREA with the box unchecked cannot', async () => {
    const jefe = await inviteAndAccept({ email: 'jefe.sin@empresa.com', role: 'JEFE_AREA' });
    expect(jefe.user.canCreateTasks).toBe(false);
    expect((await call('POST', '/api/v1/tasks', { token: jefe.accessToken, body: { title: 'x' } })).status).toBe(403);
  });

  it('the checkbox is ignored for other roles', async () => {
    const user = await inviteAndAccept({ email: 'usuario@empresa.com', role: 'USER', canCreateTasks: true });
    expect(user.user.canCreateTasks).toBe(false);
    expect((await call('POST', '/api/v1/tasks', { token: user.accessToken, body: { title: 'x' } })).status).toBe(403);

    await call('PATCH', `/api/v1/users/${s.mkt.user.id}`, { token: s.admin.token, body: { canCreateTasks: true } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.mkt.user.id } })).canCreateTasks).toBe(false);
  });

  it('demoting a JEFE_AREA clears the grant; promoting again does not restore it silently', async () => {
    await call('PATCH', `/api/v1/users/${s.mkt.jefe.id}`, { token: s.admin.token, body: { role: 'USER' } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.mkt.jefe.id } })).canCreateTasks).toBe(false);
    await call('PATCH', `/api/v1/users/${s.mkt.jefe.id}`, { token: s.admin.token, body: { role: 'JEFE_AREA' } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: s.mkt.jefe.id } })).canCreateTasks).toBe(false);
  });

  it('the grant is audited and exposed to the frontend', async () => {
    await call('PATCH', `/api/v1/users/${s.mkt.jefeNoGrant.id}`, { token: s.admin.token, body: { canCreateTasks: true } });
    const log = await prisma.activityLog.findFirst({ where: { action: 'USER_UPDATED', entityId: s.mkt.jefeNoGrant.id } });
    expect(log?.changes).toEqual({ canCreateTasks: { old: false, new: true } });

    const me = await call('GET', '/api/v1/auth/me', { token: s.mkt.jefeNoGrant.token });
    expect(me.body.user.canCreateTasks).toBe(true);
    const admin = await call('GET', '/api/v1/auth/me', { token: s.admin.token });
    expect(admin.body.user.canCreateTasks).toBe(true); // ADMIN always can
  });

  it('the database refuses the grant on any role but JEFE_AREA', async () => {
    await expect(prisma.user.update({ where: { id: s.mkt.user.id }, data: { canCreateTasks: true } })).rejects.toThrow(
      /users_can_create_tasks_jefe_only/,
    );
  });
});

describe('deactivating users', () => {
  it('soft-deletes, ends their sessions, and can be restored', async () => {
    expect((await call('DELETE', `/api/v1/users/${s.mkt.user.id}`, { token: s.admin.token })).status).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', { token: s.mkt.user.token })).status).toBe(401);
    expect(await prisma.user.count({ where: { id: s.mkt.user.id } })).toBe(1);

    const listed = await call('GET', '/api/v1/users?status=deleted', { token: s.admin.token });
    expect(listed.body.data.map((u: { id: string }) => u.id)).toEqual([s.mkt.user.id]);

    const restored = await call('POST', `/api/v1/users/${s.mkt.user.id}/restore`, { token: s.admin.token });
    expect(restored.status).toBe(200);
    const login = await call('POST', '/api/v1/auth/login', { body: { email: 'ana.mkt@empresa.com', password: 'secreto-123' } });
    expect(login.status).toBe(200);
  });
});
