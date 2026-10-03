// In-process metrics for GET /api/v1/admin/metrics (MVP Fase 4).
//
// Per instance and in memory: with several API replicas each one reports its
// own numbers, and a restart starts from zero. Enough to see report timings,
// cache hit rate and rate-limit rejections; a time-series backend (Prometheus,
// Datadog…) can scrape this endpoint later.

interface Sample {
  value: number;
  at: number;
}

const MAX_SAMPLES = 1000;
const series = new Map<string, Sample[]>();
const startedAt = Date.now();

export function recordMetric(name: string, value = 1) {
  let samples = series.get(name);
  if (!samples) series.set(name, (samples = []));
  samples.push({ value, at: Date.now() });
  if (samples.length > MAX_SAMPLES) samples.shift();
}

export function recordTimer(name: string, durationMs: number) {
  recordMetric(`${name}_ms`, Math.round(durationMs * 10) / 10);
}

// Measures `fn` into `<name>_ms` (also when it throws).
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordTimer(name, performance.now() - start);
  }
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const round = (n: number) => Math.round(n * 100) / 100;

export function getMetricsSummary() {
  const metrics: Record<string, { count: number; sum: number; avg: number; min: number; max: number; p95: number; last: number }> = {};
  for (const [name, samples] of series) {
    if (!samples.length) continue;
    const values = samples.map((s) => s.value);
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    metrics[name] = {
      count: values.length,
      sum: round(sum),
      avg: round(sum / values.length),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      p95: percentile(sorted, 95),
      last: values[values.length - 1]!,
    };
  }
  const hits = metrics.report_cache_hit?.count ?? 0;
  const misses = metrics.report_cache_miss?.count ?? 0;
  return {
    instance: { startedAt: new Date(startedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    // Hits ÷ (hits + misses) of the weekly report cache, null before any lookup.
    reportCacheHitRate: hits + misses ? round(hits / (hits + misses)) : null,
    metrics,
  };
}

// Tests start from a clean slate.
export function resetMetrics() {
  series.clear();
}
