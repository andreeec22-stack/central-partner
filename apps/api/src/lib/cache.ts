import { logger } from './logger';
import { getRedis } from './redis';

// Read-through JSON cache on Redis. Without Redis every call just loads, so
// correctness never depends on the cache — only speed does.
export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (error) {
      logger.warn('cache read failed', { key, error });
    }
  }
  const value = await load();
  if (redis) {
    redis.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch(() => undefined);
  }
  return value;
}

export async function invalidate(...keys: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || keys.length === 0) return;
  await redis.del(...keys).catch((error) => logger.warn('cache invalidate failed', { keys, error }));
}

export const cacheKeys = {
  departmentScope: (userId: string) => `perm:scope:${userId}`,
};
