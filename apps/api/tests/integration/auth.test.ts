import { drainTestOutbox } from '../../src/lib/mailer';
import { prisma } from '../../src/lib/prisma';
import { call, resetDatabase } from './helpers';

const director = { email: 'director@empresa.com', password: 'secreto-123', workspaceName: 'Central Partner' };

async function registerDirector() {
  const res = await call('POST', '/api/v1/auth/register', { body: director });
  expect(res.status).toBe(201);
  return res.body;
}

beforeEach(async () => {
  await resetDatabase();
  drainTestOutbox();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('register', () => {
  it('creates workspace, default branding, ADMIN user, preferences and audit entries', async () => {
    const body = await registerDirector();

    expect(body.user).toMatchObject({ email: director.email, role: 'ADMIN', timezone: 'UTC' });
    expect(body.workspace).toMatchObject({ name: 'Central Partner', slug: 'central-partner' });
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user.passwordHash).toBeUndefined();

    const branding = await prisma.workspaceBranding.findUniqueOrThrow({ where: { workspaceId: body.workspace.id } });
    expect(branding).toMatchObject({ colorPrimary: '#2563EB', workspaceName: 'Central Partner' });
    await expect(prisma.userNotificationPreferences.count({ where: { userId: body.user.id } })).resolves.toBe(1);

    const actions = (await prisma.activityLog.findMany({ where: { workspaceId: body.workspace.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['WORKSPACE_CREATED', 'USER_REGISTERED']));
  });

  it('gives a second workspace with the same name a distinct slug', async () => {
    await registerDirector();
    const other = await call('POST', '/api/v1/auth/register', { body: { ...director, email: 'otro@empresa.com' } });
    expect(other.status).toBe(201);
    expect(other.body.workspace.slug).not.toBe('central-partner');
  });

  it('rejects invalid input with field details', async () => {
    const res = await call('POST', '/api/v1/auth/register', { body: { email: 'nope', password: '1', workspaceName: '' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['email', 'password', 'workspaceName']);
  });
});

describe('login', () => {
  it('logs in with correct credentials and rejects wrong ones identically', async () => {
    await registerDirector();

    const ok = await call('POST', '/api/v1/auth/login', { body: { email: 'DIRECTOR@empresa.com', password: director.password } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/cp_refresh=.*HttpOnly/i);

    const wrongPassword = await call('POST', '/api/v1/auth/login', { body: { email: director.email, password: 'incorrecta' } });
    const unknownEmail = await call('POST', '/api/v1/auth/login', { body: { email: 'nadie@empresa.com', password: 'incorrecta' } });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe(unknownEmail.body.error.code);
  });

  it('asks which workspace when the same credentials match several', async () => {
    await registerDirector();
    const second = await call('POST', '/api/v1/auth/register', { body: { ...director, workspaceName: 'Otra Empresa' } });

    const ambiguous = await call('POST', '/api/v1/auth/login', { body: { email: director.email, password: director.password } });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('WORKSPACE_SELECTION_REQUIRED');
    expect(ambiguous.body.error.details.workspaces).toHaveLength(2);

    const chosen = await call('POST', '/api/v1/auth/login', {
      body: { email: director.email, password: director.password, workspaceId: second.body.workspace.id },
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.workspace.id).toBe(second.body.workspace.id);
  });
});

describe('protected routes', () => {
  it('requires a valid access token', async () => {
    const { accessToken } = await registerDirector();
    expect((await call('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await call('GET', '/api/v1/auth/me', { token: 'garbage' })).status).toBe(401);

    const me = await call('GET', '/api/v1/auth/me', { token: accessToken });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(director.email);
  });
});

describe('refresh token rotation', () => {
  it('rotates tokens, and replaying an old token revokes the session', async () => {
    const { refreshToken: first } = await registerDirector();

    const rotated = await call('POST', '/api/v1/auth/refresh-token', { body: { refreshToken: first } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first);

    const replay = await call('POST', '/api/v1/auth/refresh-token', { body: { refreshToken: first } });
    expect(replay.status).toBe(401);

    // The legitimate newest token is now dead too, and so is its access token.
    const afterReuse = await call('POST', '/api/v1/auth/refresh-token', { body: { refreshToken: rotated.body.refreshToken } });
    expect(afterReuse.status).toBe(401);
    expect((await call('GET', '/api/v1/auth/me', { token: rotated.body.accessToken })).status).toBe(401);

    const reuseLogged = await prisma.activityLog.count({ where: { action: 'REFRESH_TOKEN_REUSE_DETECTED' } });
    expect(reuseLogged).toBe(1);
  });

  it('accepts the httpOnly cookie from a trusted origin and refuses other origins', async () => {
    const { refreshToken } = await registerDirector();
    const cookie = `cp_refresh=${refreshToken}`;

    const evil = await call('POST', '/api/v1/auth/refresh-token', { headers: { cookie, origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);

    const ok = await call('POST', '/api/v1/auth/refresh-token', { headers: { cookie, origin: 'http://localhost:5173' } });
    expect(ok.status).toBe(200);
  });
});

describe('logout', () => {
  it('revokes the session so the access token stops working immediately', async () => {
    const { accessToken, refreshToken } = await registerDirector();

    const res = await call('POST', '/api/v1/auth/logout', { token: accessToken });
    expect(res.status).toBe(200);

    expect((await call('GET', '/api/v1/auth/me', { token: accessToken })).status).toBe(401);
    expect((await call('POST', '/api/v1/auth/refresh-token', { body: { refreshToken } })).status).toBe(401);
  });
});

describe('password reset', () => {
  it('emails a single-use link, changes the password, and signs out everywhere', async () => {
    const { accessToken } = await registerDirector();

    const unknown = await call('POST', '/api/v1/auth/reset-password', { body: { email: 'nadie@empresa.com' } });
    const known = await call('POST', '/api/v1/auth/reset-password', { body: { email: director.email } });
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    const mails = drainTestOutbox();
    expect(mails).toHaveLength(1);
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mails[0]!.text)![1]!);

    const confirm = await call('POST', '/api/v1/auth/reset-password/confirm', { body: { token, newPassword: 'nueva-clave-456' } });
    expect(confirm.status).toBe(200);

    const reused = await call('POST', '/api/v1/auth/reset-password/confirm', { body: { token, newPassword: 'otra-clave-789' } });
    expect(reused.status).toBe(422);

    expect((await call('GET', '/api/v1/auth/me', { token: accessToken })).status).toBe(401);
    expect((await call('POST', '/api/v1/auth/login', { body: { email: director.email, password: director.password } })).status).toBe(401);
    expect((await call('POST', '/api/v1/auth/login', { body: { email: director.email, password: 'nueva-clave-456' } })).status).toBe(200);
  });
});

describe('errors', () => {
  it('returns a JSON 404 with a request id for unknown routes', async () => {
    const res = await call('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
  });
});
