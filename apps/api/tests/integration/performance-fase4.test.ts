import { getMetricsSummary, resetMetrics } from '../../src/lib/metrics';
import { prisma } from '../../src/lib/prisma';
import { setStorage } from '../../src/lib/storage';
import { addDays, localDay, mondayOfDay } from '../../src/lib/week';
import { reportCache } from '../../src/modules/reports/report-cache';
import { reportLimits } from '../../src/modules/reports/reports.service';
import { createTask, seedWorkspace, WORKSPACE_TZ, type Seed } from './fixtures';
import { app, call, MemoryStorage, resetDatabase } from './helpers';

let s: Seed;

beforeEach(async () => {
  await resetDatabase();
  await reportCache.clear();
  resetMetrics();
  s = await seedWorkspace();
  setStorage(new MemoryStorage());
});
afterAll(async () => {
  setStorage(null);
  await prisma.$disconnect();
});

const thisMonday = () => mondayOfDay(localDay(new Date(), WORKSPACE_TZ));

// A past week with one task, closed (which also writes its report and snapshot).
async function closedWeek(weeksAgo = 1) {
  const res = await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: addDays(thisMonday(), -7 * weeksAgo) } });
  const week = res.body.week as { id: string; mondayDate: string };
  await createTask(s.mkt.jefe.token, { title: 'Campaña', assignedTo: s.mkt.user.id, dueDate: `${addDays(week.mondayDate, 1)}T17:00:00.000Z` });
  const closed = await call('POST', `/api/v1/weeks/${week.id}/close`, { token: s.admin.token, body: { force: true } });
  expect(closed.status).toBe(200);
  return week;
}

async function weekReport(weekId: string, token = s.admin.token) {
  const start = performance.now();
  const res = await app.request(`/api/v1/export/week-report?weekId=${weekId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.7' },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, source: res.headers.get('x-report-source'), headers: res.headers, bytes, ms: performance.now() - start };
}

const generate = (weekId: string) => call('POST', '/api/v1/export/generate-weekly', { token: s.admin.token, body: { weekId } });

describe('KPI snapshots on week close', () => {
  it('closing a week stores one company row and one per area', async () => {
    const week = await closedWeek();
    const rows = await prisma.weekKpiSnapshot.findMany({ where: { weekId: week.id }, orderBy: { departmentKey: 'asc' } });
    const company = rows.find((r) => r.departmentKey === 'ALL')!;
    const mkt = rows.find((r) => r.departmentKey === s.marketing)!;
    expect(rows).toHaveLength(1 + (await prisma.department.count({ where: { workspaceId: s.workspaceId } })));
    const areas = rows.filter((r) => r.departmentKey !== 'ALL');
    // The company row adds up the areas (as the dashboard's overall numbers do).
    expect(company).toMatchObject({ departmentName: null, tasksTotal: areas.reduce((n, r) => n + r.tasksTotal, 0) });
    // Same numbers as the archived week the dashboard used to read.
    const archive = await prisma.weeklyArchive.findFirstOrThrow({ where: { weekId: week.id } });
    const archived = (archive.data as any).departments.find((d: { id: string }) => d.id === s.marketing).metrics;
    expect(mkt).toMatchObject({
      departmentName: 'Marketing',
      indexValue: archived.index,
      semaphore: archived.semaphore,
      tasksTotal: archived.tasks.total,
      tasksDue: archived.tasks.due,
      tasksDone: archived.tasks.done,
      tasksOverdue: archived.tasks.overdue,
    });
    expect(mkt.tasksTotal).toBeGreaterThanOrEqual(1); // includes the task created above
  });

  it('history and trends read the snapshot and give the same numbers as recomputing', async () => {
    await closedWeek(2);
    await closedWeek(1);
    const fromSnapshots = await call('GET', '/api/v1/dashboard/week/history?limit=4', { token: s.admin.token });
    const trends = await call('GET', '/api/v1/dashboard/trends?weeks=3', { token: s.admin.token });
    expect(fromSnapshots.status).toBe(200);
    expect(trends.status).toBe(200);
    expect(getMetricsSummary().metrics.week_history_snapshot_hit?.count).toBeGreaterThanOrEqual(2);

    await prisma.weekKpiSnapshot.deleteMany({});
    resetMetrics();
    const recomputed = await call('GET', '/api/v1/dashboard/week/history?limit=4', { token: s.admin.token });
    expect(getMetricsSummary().metrics.week_history_snapshot_hit).toBeUndefined();
    expect(recomputed.body).toEqual(fromSnapshots.body);
  });

  it('an area lead only sees their own area in the snapshot history', async () => {
    await closedWeek();
    const res = await call('GET', '/api/v1/dashboard/trends?weeks=2', { token: s.mkt.jefe.token });
    expect(res.status).toBe(200);
    for (const point of res.body.data) expect(point.departments.map((d: { id: string }) => d.id)).toEqual([s.marketing]);
  });
});

describe('report generation rate limit', () => {
  it('3 manual generations per workspace per hour; the 4th gets 429 EXPORT_RATE_LIMITED', async () => {
    const week = await closedWeek(); // the automatic report on close does not count
    for (let i = 0; i < reportLimits.perHour; i++) expect((await generate(week.id)).status).toBe(201);
    const fourth = await generate(week.id);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatchObject({ code: 'EXPORT_RATE_LIMITED', details: { maxPerHour: 3, retryAfterSeconds: expect.any(Number) } });
    expect(getMetricsSummary().metrics.report_rate_limited?.count).toBe(1);

    // Downloads of what exists are not generations.
    expect((await weekReport(week.id)).status).toBe(200);
  });

  it('the quota is per workspace', async () => {
    const week = await closedWeek();
    for (let i = 0; i < reportLimits.perHour; i++) await generate(week.id);
    const other = await call('POST', '/api/v1/auth/register', {
      body: { email: 'otra@empresa.com', password: 'secreto-123', workspaceName: 'Otra empresa' },
    });
    const token = other.body.accessToken as string;
    const otherWeek = await call('POST', '/api/v1/weeks', { token, body: { mondayDate: addDays(thisMonday(), -7) } });
    const res = await call('POST', '/api/v1/export/generate-weekly', { token, body: { weekId: otherWeek.body.week.id } });
    expect(res.status).toBe(201);
  });
});

describe('week report cache', () => {
  it('serves storage → cache, and generates when nothing is stored', async () => {
    const week = await closedWeek();
    const first = await weekReport(week.id);
    expect(first).toMatchObject({ status: 200, source: 'storage' });
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const second = await weekReport(week.id);
    expect(second.source).toBe('cache');
    expect(second.bytes).toEqual(first.bytes);
    expect(second.ms).toBeLessThan(100);
    expect(await prisma.activityLog.count({ where: { action: 'REPORT_DOWNLOADED' } })).toBe(2);

    // An open week with no stored report is generated on demand (< 5 s).
    const open = await call('POST', '/api/v1/weeks', { token: s.admin.token, body: { mondayDate: addDays(thisMonday(), -14) } });
    const generated = await weekReport(open.body.week.id);
    expect(generated.source).toBe('generated');
    expect(generated.ms).toBeLessThan(5000);
    expect((await weekReport(open.body.week.id)).source).toBe('cache');
  });

  it('regenerating or deleting the report drops the cached copy', async () => {
    const week = await closedWeek();
    await weekReport(week.id);
    expect((await weekReport(week.id)).source).toBe('cache');

    const regenerated = await generate(week.id);
    expect((await weekReport(week.id)).source).toBe('storage');

    await call('DELETE', `/api/v1/export/${regenerated.body.exportId}`, { token: s.admin.token });
    const afterDelete = await weekReport(week.id);
    expect(afterDelete.source).toBe('storage'); // falls back to the report made on close
    const latest = await prisma.weeklyReport.findFirst({ where: { weekId: week.id, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    expect(latest?.source).toBe('WEEK_CLOSED');
  });

  it('is ADMIN only', async () => {
    const week = await closedWeek();
    for (const actor of [s.mkt.jefe, s.mkt.user, s.mkt.viewer]) expect((await weekReport(week.id, actor.token)).status).toBe(403);
  });
});

describe('GET /api/v1/admin/metrics', () => {
  it('is ADMIN only and reports timings and the cache hit rate', async () => {
    const week = await closedWeek();
    await weekReport(week.id);
    await weekReport(week.id);
    for (const actor of [s.mkt.jefe, s.mkt.user, s.mkt.viewer]) expect((await call('GET', '/api/v1/admin/metrics', { token: actor.token })).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/metrics')).status).toBe(401);

    const res = await call('GET', '/api/v1/admin/metrics', { token: s.admin.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ instance: { uptimeSeconds: expect.any(Number) }, reportCacheHitRate: 0.5 });
    expect(res.body.metrics).toHaveProperty('report_generation_ms');
    expect(res.body.metrics.week_report_from_cache.count).toBe(1);
  });

  it('API JSON is gzipped when the client accepts it', async () => {
    const res = await app.request('/api/v1/dashboard/week/history?limit=4', {
      headers: { authorization: `Bearer ${s.admin.token}`, 'accept-encoding': 'gzip', 'x-forwarded-for': '203.0.113.7' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });
});
