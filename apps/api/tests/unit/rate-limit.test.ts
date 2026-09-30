import { Hono } from 'hono';
import { signAccessToken } from '../../src/lib/tokens';
import { errorHandler } from '../../src/middleware/error-handler';
import { MemoryCounter, rateLimit, userOrIpKey } from '../../src/middleware/rate-limit';
import type { AppEnv } from '../../src/types';

describe('MemoryCounter', () => {
  it('counts hits within a window and resets after it', async () => {
    let now = 1_000_000;
    const counter = new MemoryCounter(() => now);

    expect((await counter.hit('k', 60)).count).toBe(1);
    expect((await counter.hit('k', 60)).count).toBe(2);
    expect((await counter.hit('other', 60)).count).toBe(1);

    now += 59_000;
    const beforeReset = await counter.hit('k', 60);
    expect(beforeReset.count).toBe(3);
    expect(beforeReset.resetInSeconds).toBe(1);

    now += 1_000;
    expect((await counter.hit('k', 60)).count).toBe(1);
  });
});

describe('global limiter key (S6)', () => {
  // Same office NAT for everyone: one public IP.
  const OFFICE_IP = '203.0.113.7';

  function limitedApp(max: number) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('clientIp', OFFICE_IP);
      await next();
    });
    app.use('*', rateLimit({ prefix: `s6-${Math.random()}`, max, windowSeconds: 60, keyBy: userOrIpKey }));
    app.onError(errorHandler);
    app.get('/', (c) => c.text('ok'));
    return app;
  }
  const token = (sub: string) => signAccessToken({ sub, wid: 'ws', sid: 'sess', role: 'USER' });
  const get = async (app: Hono<AppEnv>, t?: string) => (await app.request('/', { headers: t ? { authorization: `Bearer ${t}` } : {} })).status;

  it('gives each signed-in person their own budget behind a shared IP', async () => {
    const app = limitedApp(2);
    const ana = token('ana');
    expect([await get(app, ana), await get(app, ana), await get(app, ana)]).toEqual([200, 200, 429]);
    // Same IP, another person: unaffected.
    expect(await get(app, token('luis'))).toBe(200);
    // Anonymous calls from that IP have their own (IP) budget.
    expect([await get(app), await get(app), await get(app)]).toEqual([200, 200, 429]);
  });

  it('falls back to the IP for missing or forged tokens', () => {
    const ctx = (authorization?: string) =>
      ({ req: { header: () => authorization }, get: () => OFFICE_IP }) as unknown as Parameters<typeof userOrIpKey>[0];
    expect(userOrIpKey(ctx(`Bearer ${token('ana')}`))).toBe('user:ana');
    expect(userOrIpKey(ctx())).toBe(`ip:${OFFICE_IP}`);
    expect(userOrIpKey(ctx('Bearer not-a-jwt'))).toBe(`ip:${OFFICE_IP}`);
    expect(userOrIpKey(ctx(`Bearer ${token('ana')}x`))).toBe(`ip:${OFFICE_IP}`);
  });
});
