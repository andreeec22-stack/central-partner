import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { tooManyRequests } from '../lib/errors';
import { getRedis } from '../lib/redis';
import { verifyAccessToken } from '../lib/tokens';
import type { AppEnv } from '../types';

// Fixed-window counter. Redis when available (shared across instances), otherwise
// an in-process map so limits still apply in dev or during a Redis outage.
export interface Counter {
  hit(key: string, windowSeconds: number): Promise<{ count: number; resetInSeconds: number }>;
}

export class MemoryCounter implements Counter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowSeconds: number) {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.windows.set(key, entry);
      if (this.windows.size > 10_000) this.sweep(now);
    }
    entry.count += 1;
    return { count: entry.count, resetInSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  private sweep(now: number) {
    for (const [k, v] of this.windows) if (v.resetAt <= now) this.windows.delete(k);
  }
}

const memory = new MemoryCounter();

async function hit(key: string, windowSeconds: number) {
  const redis = getRedis();
  if (redis) {
    try {
      const results = await redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
      return { count, resetInSeconds: ttl > 0 ? ttl : windowSeconds };
    } catch {
      // fall through to memory
    }
  }
  return memory.hit(key, windowSeconds);
}

// S6: the global /api limiter runs before requireAuth, so c.get('user') is still
// empty there and the key used to fall back to the IP — a whole office behind
// one NAT shared a single budget. A valid access token identifies the person
// instead (signature check only, no DB); anonymous or invalid → the IP.
export function userOrIpKey(c: Context<AppEnv>): string {
  const header = c.req.header('authorization');
  const claims = header?.startsWith('Bearer ') ? verifyAccessToken(header.slice(7).trim()) : null;
  return claims ? `user:${claims.sub}` : `ip:${c.get('clientIp')}`;
}

interface Options {
  prefix: string;
  max: number;
  windowSeconds: number;
  keyBy?: (c: Context<AppEnv>) => string;
}

export const rateLimit = ({ prefix, max, windowSeconds, keyBy }: Options) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const identity = keyBy ? keyBy(c) : (c.get('user')?.id ?? c.get('clientIp'));
    const { count, resetInSeconds } = await hit(`rl:${prefix}:${identity}`, windowSeconds);
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - count)));
    if (count > max) throw tooManyRequests(resetInSeconds);
    await next();
  });
