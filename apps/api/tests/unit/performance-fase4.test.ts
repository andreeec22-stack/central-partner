import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { getMetricsSummary, recordMetric, recordTimer, resetMetrics } from '../../src/lib/metrics';
import { consumeQuota } from '../../src/middleware/rate-limit';
import { ReportCacheService, reportCacheKey } from '../../src/modules/reports/report-cache';
import { COMPANY_KEY, snapshotRows } from '../../src/modules/weeks/kpi-snapshot';
import type { WeekData } from '../../src/modules/weeks/week-data';

beforeEach(() => resetMetrics());
afterEach(() => jest.useRealTimers());

describe('metrics', () => {
  it('summarizes count, avg, min, max, p95 and last per metric', () => {
    for (const v of [10, 20, 30, 40, 1000]) recordTimer('report_generation', v);
    recordMetric('report_generated');
    const { metrics } = getMetricsSummary();
    expect(metrics.report_generation_ms).toMatchObject({ count: 5, avg: 220, min: 10, max: 1000, p95: 1000, last: 1000 });
    expect(metrics.report_generated).toMatchObject({ count: 1, sum: 1 });
  });

  it('reports the cache hit rate', () => {
    expect(getMetricsSummary().reportCacheHitRate).toBeNull();
    for (let i = 0; i < 4; i++) recordMetric('report_cache_hit');
    recordMetric('report_cache_miss');
    expect(getMetricsSummary().reportCacheHitRate).toBe(0.8);
  });
});

describe('ReportCacheService (memory fallback, no Redis in tests)', () => {
  const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

  it('stores, serves and invalidates a report; counts hits and misses', async () => {
    const cache = new ReportCacheService();
    const key = reportCacheKey('ws1', 'w1');
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, { data: bytes(10), filename: 'Semana40.xlsx' });
    expect(await cache.get(key)).toEqual({ data: bytes(10), filename: 'Semana40.xlsx' });
    await cache.invalidate(key);
    expect(await cache.get(key)).toBeNull();
    expect(getMetricsSummary()).toMatchObject({ reportCacheHitRate: 0.33 });
  });

  it('invalidates every week of a workspace, and only that workspace', async () => {
    const cache = new ReportCacheService();
    await cache.set(reportCacheKey('ws1', 'w1'), { data: bytes(1), filename: 'a' });
    await cache.set(reportCacheKey('ws1', 'w2'), { data: bytes(1), filename: 'b' });
    await cache.set(reportCacheKey('ws2', 'w1'), { data: bytes(1), filename: 'c' });
    await cache.invalidateWorkspace('ws1');
    expect(await cache.get(reportCacheKey('ws1', 'w1'))).toBeNull();
    expect(await cache.get(reportCacheKey('ws1', 'w2'))).toBeNull();
    expect(await cache.get(reportCacheKey('ws2', 'w1'))).not.toBeNull();
  });

  it('expires entries after the TTL', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-01T12:00:00Z') });
    const cache = new ReportCacheService({ ttlMs: 60_000 });
    await cache.set('k', { data: bytes(1), filename: 'x' });
    jest.setSystemTime(new Date('2026-10-01T12:00:59Z'));
    expect(await cache.get('k')).not.toBeNull();
    jest.setSystemTime(new Date('2026-10-01T12:01:01Z'));
    expect(await cache.get('k')).toBeNull();
  });

  it('stays within its memory bounds, evicting the oldest first', async () => {
    const cache = new ReportCacheService({ maxEntries: 2, maxBytes: 100 });
    await cache.set('a', { data: bytes(40), filename: 'a' });
    await cache.set('b', { data: bytes(40), filename: 'b' });
    await cache.set('c', { data: bytes(40), filename: 'c' }); // over 2 entries / 100 bytes → "a" goes
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
    await cache.set('huge', { data: bytes(101), filename: 'h' }); // bigger than the whole cache: not kept
    expect(await cache.get('huge')).toBeNull();
  });
});

describe('report generation quota (3 per workspace per hour)', () => {
  it('allows 3, refuses the 4th, counts workspaces apart and resets after the hour', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-01T09:00:00Z') });
    const take = (ws: string) => consumeQuota(`test-report-generation:${ws}`, 3, 3600);
    expect((await Promise.all([take('A'), take('A'), take('A')])).map((q) => q.allowed)).toEqual([true, true, true]);
    const fourth = await take('A');
    expect(fourth).toMatchObject({ allowed: false, count: 4 });
    expect(fourth.resetInSeconds).toBeLessThanOrEqual(3600);
    expect((await take('B')).allowed).toBe(true);

    jest.setSystemTime(new Date('2026-10-01T10:00:01Z'));
    expect((await take('A')).allowed).toBe(true);
  });
});

describe('compression (hono/compress)', () => {
  const app = new Hono();
  app.use('*', compress());
  app.get('/json', (c) => c.json(Array.from({ length: 500 }, (_, i) => ({ id: i, area: 'Diseño Audiovisual', index: 0.75, semaphore: 'YELLOW' }))));
  app.get('/xlsx', (c) => c.body(new Uint8Array(5000), 200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));

  it('gzips JSON (well over 85% smaller here) and the content survives', async () => {
    const plain = await (await app.request('/json')).text();
    const res = await app.request('/json', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const zipped = Buffer.from(await res.arrayBuffer());
    expect(1 - zipped.length / Buffer.byteLength(plain)).toBeGreaterThan(0.85);
    expect(gunzipSync(zipped).toString()).toBe(plain);
  });

  it('leaves already-compressed files (xlsx is a zip) alone', async () => {
    expect((await app.request('/xlsx', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get('content-encoding')).toBeNull();
    expect((await app.request('/json')).headers.get('content-encoding')).toBeNull(); // client didn't ask
  });
});

describe('week KPI snapshot rows', () => {
  it('one company row plus one per area, with the closing numbers', () => {
    const metrics = (index: number) => ({
      index,
      taskProgress: index,
      kpiCompliance: null,
      functionCompliance: 1,
      semaphore: 'YELLOW' as const,
      tasks: { total: 4, due: 3, done: 2, overdue: 1, blocked: 0 },
      kpis: { total: 0, recorded: 0 },
      functions: { total: 1, marked: 1 },
    });
    const data = {
      overall: { ...metrics(0.8), areasBySemaphore: { GREEN: 0, YELLOW: 2, RED: 0, NONE: 0 } },
      departments: [
        { id: 'd1', name: 'Marketing', metrics: metrics(0.7) },
        { id: 'd2', name: 'Finanzas', metrics: metrics(0.9) },
      ],
    } as unknown as WeekData;
    const rows = snapshotRows('ws', 'w', data);
    expect(rows.map((r) => [r.departmentKey, r.departmentName, r.indexValue])).toEqual([
      [COMPANY_KEY, null, 0.8],
      ['d1', 'Marketing', 0.7],
      ['d2', 'Finanzas', 0.9],
    ]);
    expect(rows[1]).toMatchObject({ kpiCompliance: null, functionCompliance: 1, semaphore: 'YELLOW', tasksTotal: 4, tasksDue: 3, tasksDone: 2, tasksOverdue: 1 });
  });
});
