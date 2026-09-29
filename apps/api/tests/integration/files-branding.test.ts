import { prisma } from '../../src/lib/prisma';
import { setStorage } from '../../src/lib/storage';
import { createTask, seedWorkspace, type Seed } from './fixtures';
import { app, call, MemoryStorage, resetDatabase, sampleFiles, upload } from './helpers';

let s: Seed;
let storage: MemoryStorage;

beforeEach(async () => {
  await resetDatabase();
  storage = new MemoryStorage();
  setStorage(storage);
  s = await seedWorkspace();
});
afterAll(() => setStorage(null));

const filesUrl = (taskId: string) => `/api/v1/tasks/${taskId}/files`;

describe('task files', () => {
  it('uploads, lists, downloads and soft-deletes', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'Informe', assignedTo: s.mkt.user.id });
    const res = await upload(filesUrl(task.id), s.mkt.user.token, 'Informe final.pdf', sampleFiles.pdf);
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({
      taskId: task.id,
      uploadedBy: s.mkt.user.id,
      originalFilename: 'Informe final.pdf',
      mimeType: 'application/pdf',
      fileSize: sampleFiles.pdf.length,
      user: { id: s.mkt.user.id },
    });
    expect(res.body.file.fileUrl).toMatch(/^https:\/\/files\.test\//);
    const [key] = [...storage.objects.keys()];
    expect(key).toMatch(new RegExp(`^tasks/${task.id}/[0-9a-f-]{36}-Informe-final\\.pdf$`));

    // Anyone who can see the task can download; a redirect by default, JSON on request.
    const redirect = await app.request(`${filesUrl(task.id)}/${res.body.file.id}/download`, {
      headers: { authorization: `Bearer ${s.mkt.viewer.token}` },
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toContain('d=attachment');
    const json = await call('GET', `${filesUrl(task.id)}/${res.body.file.id}/download?format=json`, { token: s.mkt.viewer.token });
    expect(json.body.url).toContain(encodeURIComponent(key!));
    expect((await call('GET', `${filesUrl(task.id)}/${res.body.file.id}/download`, { token: s.fin.user.token })).status).toBe(404);

    // Only the uploader or an ADMIN deletes — not even the area head.
    expect((await call('DELETE', `${filesUrl(task.id)}/${res.body.file.id}`, { token: s.mkt.jefe.token })).status).toBe(403);
    expect((await call('DELETE', `${filesUrl(task.id)}/${res.body.file.id}`, { token: s.mkt.user.token })).status).toBe(200);
    expect((await call('GET', filesUrl(task.id), { token: s.mkt.user.token })).body.data).toEqual([]);
    // Soft delete: the row and the stored object are kept for the audit trail.
    expect((await prisma.taskFile.findFirstOrThrow()).deletedAt).not.toBeNull();
    expect(storage.objects.size).toBe(1);
  });

  it('rejects disallowed or disguised files', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'X' });
    const exe = await upload(filesUrl(task.id), s.mkt.jefe.token, 'setup.exe', sampleFiles.exe);
    expect(exe.status).toBe(422);
    // An executable renamed to .pdf fails the content check.
    expect((await upload(filesUrl(task.id), s.mkt.jefe.token, 'factura.pdf', sampleFiles.exe)).status).toBe(422);
    expect((await upload(filesUrl(task.id), s.mkt.jefe.token, 'vacío.pdf', new Uint8Array())).status).toBe(422);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects files over 50MB', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'X' });
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    big.set(sampleFiles.pdf);
    const res = await upload(filesUrl(task.id), s.mkt.jefe.token, 'grande.pdf', big);
    expect(res.status).toBe(413);
  });

  it('caps files per task and checks who may upload', async () => {
    const task = await createTask(s.mkt.jefe.token, { title: 'X' });
    expect((await upload(filesUrl(task.id), s.mkt.viewer.token, 'a.pdf', sampleFiles.pdf)).status).toBe(403);
    for (let i = 0; i < 10; i++) {
      expect((await upload(filesUrl(task.id), s.mkt.user.token, `f${i}.png`, sampleFiles.png)).status).toBe(201);
    }
    const eleventh = await upload(filesUrl(task.id), s.mkt.user.token, 'f10.png', sampleFiles.png);
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error.code).toBe('FILE_LIMIT_REACHED');
  });
});

describe('branding', () => {
  const brandingUrl = () => `/api/v1/workspaces/${s.workspaceId}/branding`;

  it('reads for members, updates for ADMINs only, and renames the workspace', async () => {
    const read = await call('GET', brandingUrl(), { token: s.mkt.user.token });
    expect(read.status).toBe(200);
    expect(read.body.branding.colors.primary).toBe('#2563EB');

    const body = { workspaceName: 'La Cocina', tagline: 'Sabor', colors: { primary: '#aa3300' } };
    expect((await call('PATCH', brandingUrl(), { token: s.mkt.jefe.token, body })).status).toBe(403);
    const res = await call('PATCH', brandingUrl(), { token: s.admin.token, body });
    expect(res.status).toBe(200);
    expect(res.body.branding).toMatchObject({ workspaceName: 'La Cocina', tagline: 'Sabor', colors: { primary: '#AA3300', success: '#10B981' } });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } })).name).toBe('La Cocina');

    expect((await call('PATCH', brandingUrl(), { token: s.admin.token, body: { colors: { primary: 'red' } } })).status).toBe(422);
    expect((await call('GET', `/api/v1/workspaces/${crypto.randomUUID()}/branding`, { token: s.admin.token })).status).toBe(404);
  });

  it('uploads a logo served publicly, and refuses unsafe SVGs', async () => {
    const url = `${brandingUrl()}/logo/upload`;
    expect((await upload(url, s.mkt.jefe.token, 'logo.png', sampleFiles.png)).status).toBe(403);
    expect((await upload(url, s.admin.token, 'logo.pdf', sampleFiles.pdf)).status).toBe(422);
    expect((await upload(url, s.admin.token, 'logo.svg', sampleFiles.evilSvg)).status).toBe(422);

    const res = await upload(url, s.admin.token, 'logo.svg', sampleFiles.svg);
    expect(res.status).toBe(201);
    expect(res.body.logoUrl).toMatch(new RegExp(`/api/v1/public/workspaces/${s.workspaceId}/logo\\?v=\\d+$`));

    const logo = await app.request(res.body.logoUrl);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/svg+xml');
    expect(logo.headers.get('content-security-policy')).toContain('sandbox');
    expect(logo.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(sampleFiles.svg);

    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(sampleFiles.png);
    expect((await upload(url, s.admin.token, 'huge.png', big)).status).toBe(413);
  });
});
