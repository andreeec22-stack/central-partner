import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';

export const app = createApp();

export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

interface RequestOptions {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

export async function call(method: string, path: string, { body, token, headers = {} }: RequestOptions = {}) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

export async function upload(path: string, token: string, filename: string, bytes: Uint8Array, method = 'POST') {
  const form = new FormData();
  form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], filename));
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.7' },
    body: form,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

// In-memory storage so tests never touch disk or S3.
export class MemoryStorage {
  readonly kind = 'local' as const;
  objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { bytes: new Uint8Array(body), contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.bytes ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async signedUrl(key: string, opts: { filename: string; disposition: string }) {
    return `https://files.test/${encodeURIComponent(key)}?name=${encodeURIComponent(opts.filename)}&d=${opts.disposition}`;
  }
}

// Minimal files with the right leading bytes for each type.
export const sampleFiles = {
  pdf: new TextEncoder().encode('%PDF-1.4\n%fake\n'),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  exe: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
  svg: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'),
  evilSvg: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
};
