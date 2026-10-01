import ExcelJS from 'exceljs';
import { prisma } from '../../src/lib/prisma';
import { setStorage } from '../../src/lib/storage';
import { addDays, localDay, mondayOfDay } from '../../src/lib/week';
import { purgeExpiredReports, reportLimits } from '../../src/modules/reports/reports.service';
import { createTask, seedWorkspace, WORKSPACE_TZ, type Seed } from './fixtures';
import { app, call, MemoryStorage, resetDatabase } from './helpers';

let s: Seed;
let storage: MemoryStorage;

beforeEach(async () => {
  await resetDatabase();
  s = await seedWorkspace();
  storage = new MemoryStorage();
  setStorage(storage);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  setStorage(null);
  await prisma.$disconnect();
});

// A past week can be closed any day.
const lastMonday = () => addDays(mondayOfDay(localDay(new Date(), WORKSPACE_TZ)), -7);

async function closedWeek() {
  const res = await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: lastMonday() } });
  const week = res.body.week as { id: string; mondayDate: string; weekNumber: number };
  await createTask(s.mkt.jefe.token, { title: 'Campaña ñandú', assignedTo: s.mkt.user.id, dueDate: `${addDays(week.mondayDate, 1)}T17:00:00.000Z` });
  const closed = await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });
  expect(closed.status).toBe(200);
  return { week, closed: closed.body };
}

async function download(id: string, token = s.admin.token) {
  const res = await app.request(`/api/v1/export/${id}/download`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.7' } });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe('weekly Excel report', () => {
  it('is generated when the week closes, stored 30 days and downloadable by an ADMIN', async () => {
    const { week, closed } = await closedWeek();
    expect(closed.report).toMatchObject({ source: 'WEEK_CLOSED', status: 'AVAILABLE', week: { id: week.id }, sheetCount: 5 });
    const days = (new Date(closed.report.expiresAt).getTime() - new Date(closed.report.createdAt).getTime()) / 86_400_000;
    expect(days).toBe(30);
    expect(storage.objects.size).toBe(1);

    const file = await download(closed.report.id);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('spreadsheetml');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.bytes.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen', 'Finanzas', 'Marketing', 'Histórico', 'Notas']) // areas in alphabetical order, as on the dashboard;
    expect(JSON.stringify(wb.getWorksheet('Marketing')!.getSheetValues())).toContain('Campaña ñandú');

    const list = await call('GET', '/api/v1/export', { token: s.admin.token });
    expect(list.body.data).toHaveLength(1);
    expect(await prisma.activityLog.count({ where: { action: { in: ['REPORT_GENERATED', 'REPORT_DOWNLOADED'] } } })).toBe(2);
  });

  it('E2.4: only ADMINs generate, list, download or delete', async () => {
    const { closed } = await closedWeek();
    for (const actor of [s.mkt.jefe, s.mkt.user, s.mkt.viewer]) {
      expect((await call('GET', '/api/v1/export', { token: actor.token })).status).toBe(403);
      expect((await download(closed.report.id, actor.token)).status).toBe(403);
      expect((await call('DELETE', `/api/v1/export/${closed.report.id}`, { token: actor.token })).status).toBe(403);
    }
    expect((await call('POST', '/api/v1/export/generate-weekly', { token: s.mkt.jefe.token, body: { weekId: closed.week.id } })).status).toBe(403);
  });

  it('manual generation validates the format and the week', async () => {
    const { week } = await closedWeek();
    const csv = await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id, format: 'csv' } });
    expect(csv.status).toBe(422);
    expect(csv.body.error.code).toBe('INVALID_FORMAT');
    const missing = await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: '00000000-0000-4000-8000-000000000000' } });
    expect(missing.body.error.code).toBe('WEEK_NOT_FOUND');

    const res = await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, exportId: expect.any(String), downloadUrl: `/api/v1/export/${res.body.exportId}/download`, size: expect.any(Number) });
  });

  it('E2.5: a second generation of the same week while one runs gets 409', async () => {
    const { week } = await closedWeek();
    // Hold the first generation inside its storage write (while it holds the lock).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const realPut = storage.put.bind(storage);
    jest.spyOn(storage, 'put').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realPut(...args);
    });

    const first = call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id } });
    await inside;
    const second = await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EXPORT_IN_PROGRESS');
    release();
    expect((await first).status).toBe(201);
    // Once released, the week can be generated again.
    expect((await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id } })).status).toBe(201);
  });

  it('E2.1: refuses weeks with more rows than the limit (413)', async () => {
    const { week } = await closedWeek();
    const saved = { ...reportLimits };
    reportLimits.maxRows = 10;
    try {
      const res = await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id } });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
      reportLimits.maxRows = saved.maxRows;
      reportLimits.maxBytes = 100;
      expect((await call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId: week.id } })).body.error.code).toBe('FILE_TOO_LARGE');
    } finally {
      Object.assign(reportLimits, saved);
    }
  });

  it('soft delete hides it and restore brings it back', async () => {
    const { closed } = await closedWeek();
    const id = closed.report.id;
    expect((await call('DELETE', `/api/v1/export/${id}`, { token: s.admin.token })).body.report.status).toBe('DELETED');
    expect((await download(id)).status).toBe(404);
    expect((await call('GET', '/api/v1/export', { token: s.admin.token })).body.data).toHaveLength(0);
    expect((await call('GET', '/api/v1/export?includeDeleted=true', { token: s.admin.token })).body.data).toHaveLength(1);
    expect(storage.objects.size).toBe(1); // the file is kept for recovery

    expect((await call('POST', `/api/v1/export/${id}/restore`, { token: s.admin.token })).body.report.status).toBe('AVAILABLE');
    expect((await download(id)).status).toBe(200);
  });

  it('E2.6: expired reports answer 410 and the cleanup removes their files', async () => {
    const { closed } = await closedWeek();
    const id = closed.report.id;
    await prisma.weeklyReport.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await download(id);
    expect(res.status).toBe(410);
    expect((await call('POST', `/api/v1/export/${id}/restore`, { token: s.admin.token })).status).toBe(410);

    expect(await purgeExpiredReports()).toBe(1);
    expect(storage.objects.size).toBe(0);
    expect((await prisma.weeklyReport.findUniqueOrThrow({ where: { id } })).purgedAt).not.toBeNull();
    expect(await purgeExpiredReports()).toBe(0); // idempotent
    expect(await prisma.activityLog.count({ where: { action: 'REPORTS_PURGED' } })).toBe(1);
  });

  it('a failing report never blocks closing the week', async () => {
    jest.spyOn(storage, 'put').mockRejectedValue(new Error('storage down'));
    const { closed } = await closedWeek();
    expect(closed.report).toBeNull();
    expect(closed.week.status).toBe('ARCHIVED');
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'REPORT_GENERATION_FAILED' } });
    expect(log.metadata).toMatchObject({ message: 'storage down' });
  });
});
