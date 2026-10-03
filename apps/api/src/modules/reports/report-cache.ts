import { logger } from '../../lib/logger';
import { recordMetric } from '../../lib/metrics';
import { getRedis } from '../../lib/redis';

// Weekly report cache (MVP Fase 4): the bytes of a week's report, keyed
// `report:{workspaceId}:{weekId}`, served by POST /export/week-report without
// touching storage or regenerating. Redis when available (shared by replicas),
// an in-memory map otherwise; a cache failure is only a miss, never an error.
// Invalidated when the week's reports change (close, regenerate, delete,
// restore, purge).

export interface CachedReport {
  data: Uint8Array;
  filename: string;
}

interface CacheOptions {
  ttlMs?: number;
  // Memory fallback bounds: reports are MBs, the process must not grow unbounded.
  maxEntries?: number;
  maxBytes?: number;
}

export const reportCacheKey = (workspaceId: string, weekId: string) => `report:${workspaceId}:${weekId}`;

export class ReportCacheService {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  // Insertion order = age: the first entry is the oldest (evicted first).
  private readonly memory = new Map<string, CachedReport & { expiresAt: number }>();

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 50;
    this.maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  }

  async get(key: string): Promise<CachedReport | null> {
    const found = await this.read(key);
    recordMetric(found ? 'report_cache_hit' : 'report_cache_miss');
    return found;
  }

  private async read(key: string): Promise<CachedReport | null> {
    const redis = getRedis();
    if (redis) {
      try {
        const [data, filename] = await Promise.all([redis.getBuffer(key), redis.get(`${key}:name`)]);
        return data && filename ? { data: new Uint8Array(data), filename } : null;
      } catch (error) {
        logger.warn('report cache read failed', { key, error });
        return null;
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return { data: entry.data, filename: entry.filename };
  }

  async set(key: string, value: CachedReport): Promise<void> {
    const redis = getRedis();
    if (redis) {
      const seconds = Math.max(1, Math.floor(this.ttlMs / 1000));
      try {
        await redis.multi().set(key, Buffer.from(value.data), 'EX', seconds).set(`${key}:name`, value.filename, 'EX', seconds).exec();
      } catch (error) {
        logger.warn('report cache write failed', { key, error });
      }
      return;
    }
    if (value.data.byteLength > this.maxBytes) return;
    this.memory.delete(key);
    this.memory.set(key, { ...value, expiresAt: Date.now() + this.ttlMs });
    this.evict();
  }

  private evict() {
    const now = Date.now();
    for (const [k, v] of this.memory) if (v.expiresAt <= now) this.memory.delete(k);
    let bytes = [...this.memory.values()].reduce((sum, v) => sum + v.data.byteLength, 0);
    for (const [k, v] of this.memory) {
      if (this.memory.size <= this.maxEntries && bytes <= this.maxBytes) break;
      this.memory.delete(k);
      bytes -= v.data.byteLength;
    }
  }

  async invalidate(key: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      await redis.del(key, `${key}:name`).catch((error) => logger.warn('report cache invalidate failed', { key, error }));
    }
    this.memory.delete(key);
  }

  // Every week of a workspace. SCAN, never KEYS (which blocks Redis).
  async invalidateWorkspace(workspaceId: string): Promise<void> {
    const prefix = `report:${workspaceId}:`;
    const redis = getRedis();
    if (redis) {
      try {
        const keys: string[] = [];
        for await (const batch of redis.scanStream({ match: `${prefix}*`, count: 200 })) keys.push(...(batch as string[]));
        if (keys.length) await redis.del(...keys);
      } catch (error) {
        logger.warn('report cache workspace invalidate failed', { workspaceId, error });
      }
    }
    for (const k of this.memory.keys()) if (k.startsWith(prefix)) this.memory.delete(k);
  }

  // Tests.
  clear() {
    this.memory.clear();
  }
}

export const reportCache = new ReportCacheService();
