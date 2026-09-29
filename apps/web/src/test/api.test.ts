import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, configureApi } from '../lib/api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let token: string | null;
const expired = vi.fn();

beforeEach(() => {
  token = 'old';
  expired.mockReset();
  configureApi({ getToken: () => token, setToken: (t) => (token = t), onSessionExpired: expired });
});

describe('api client', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh-token')) return json(200, { accessToken: 'new' });
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer new' ? json(200, { ok: true }) : json(401, { error: { code: 'TOKEN_INVALID', message: 'expired' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/tasks')).resolves.toEqual({ ok: true });
    expect(token).toBe('new');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/refresh-token'))).toHaveLength(1);
  });

  it('shares a single refresh between concurrent 401s', async () => {
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/refresh-token')) {
          refreshes++;
          await new Promise((r) => setTimeout(r, 10));
          return json(200, { accessToken: 'new' });
        }
        const auth = (init?.headers as Record<string, string>).Authorization;
        return auth === 'Bearer new' ? json(200, {}) : json(401, {});
      }),
    );
    await Promise.all([api('/a'), api('/b'), api('/c')]);
    expect(refreshes).toBe(1);
  });

  it('reports an expired session when the refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/refresh-token') ? json(401, {}) : json(401, { error: { code: 'TOKEN_INVALID', message: 'expired' } }),
      ),
    );
    await expect(api('/tasks')).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    expect(expired).toHaveBeenCalledOnce();
  });

  it('exposes field errors from a 422', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(422, {
          error: { code: 'VALIDATION_ERROR', message: 'Invalid', details: [{ field: 'blockReason', message: 'required' }] },
        }),
      ),
    );
    const err = await api('/tasks/1', { method: 'PATCH', body: { status: 'BLOCKED' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fieldErrors).toEqual({ blockReason: 'required' });
  });

  it('serializes query params and skips empty values', async () => {
    const fetchMock = vi.fn(async (_url: string) => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await api('/tasks', { query: { week: 'this', status: 'TODO,BLOCKED', search: '', departmentId: undefined } });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/tasks?week=this&status=TODO%2CBLOCKED');
  });
});
