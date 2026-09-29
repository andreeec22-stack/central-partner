import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

// Redis is an accelerator, never a hard dependency: when REDIS_URL is empty or
// Redis is down, callers get null and fall back (e.g. in-memory rate limiting).
let client: Redis | null = null;
let ready = false;

export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 10_000),
    });
    client.on('ready', () => {
      ready = true;
      logger.info('redis connected');
    });
    client.on('end', () => {
      ready = false;
    });
    client.on('error', (error) => {
      if (ready) logger.warn('redis error', { error });
      ready = false;
    });
  }
  return ready ? client : null;
}

export async function closeRedis() {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
    ready = false;
  }
}
