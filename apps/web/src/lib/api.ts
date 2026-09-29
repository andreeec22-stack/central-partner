// Thin fetch wrapper for /api/v1.
//
// The access token lives only in memory (never localStorage, so an XSS can't
// lift a long-lived credential). The refresh token is an httpOnly cookie the
// browser sends to /api/v1/auth/*. On a 401 the client refreshes once and
// retries; concurrent 401s share one refresh, and refreshes are serialized
// across tabs with the Web Locks API — the server rotates refresh tokens and
// treats reuse as theft, so two tabs must never refresh with the same cookie.

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  // Field-level messages from a 422, keyed by field name.
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { field?: string; message?: string }[]) {
        if (d.field && d.message && !out[d.field]) out[d.field] = d.message;
      }
    }
    return out;
  }
}

interface TokenHandlers {
  getToken: () => string | null;
  setToken: (token: string | null) => void;
  onSessionExpired: () => void;
}

let handlers: TokenHandlers = {
  getToken: () => null,
  setToken: () => undefined,
  onSessionExpired: () => undefined,
};

export function configureApi(h: TokenHandlers) {
  handlers = h;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error (proxy down, etc.)
  }
  return new ApiError(
    res.status,
    body?.error?.code ?? 'HTTP_ERROR',
    body?.error?.message ?? (res.status >= 500 ? 'El servidor no respondió correctamente' : res.statusText),
    body?.error?.details,
  );
}

async function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('cp-refresh-token', fn) as Promise<T>;
  }
  return fn();
}

let refreshing: Promise<string | null> | null = null;

// Returns a fresh access token, or null when the session is gone.
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= withCrossTabLock(async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh-token`, { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string };
      handlers.setToken(body.accessToken);
      return body.accessToken;
    } catch {
      return null;
    }
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  // Auth endpoints must not trigger the refresh-and-retry dance.
  skipAuthRetry?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = `${BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  // FormData goes as-is: the browser sets the multipart boundary itself.
  const isForm = opts.body instanceof FormData;
  const send = (token: string | null) =>
    fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      credentials: 'include',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });

  let res = await send(handlers.getToken());
  if (res.status === 401 && !opts.skipAuthRetry) {
    const token = await refreshAccessToken();
    if (!token) {
      handlers.onSessionExpired();
      throw await parseError(res);
    }
    res = await send(token);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Multipart upload of a single file in the field the API expects ("file").
export function uploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return api<T>(path, { method: 'POST', body: form });
}
