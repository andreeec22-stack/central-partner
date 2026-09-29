import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

// Object storage for task files, Excel imports and logos.
//   AWS_S3_BUCKET set → S3 (presigned GET URLs straight to the bucket)
//   otherwise         → local disk + HMAC-signed, expiring API URLs (dev)
// Objects are never deleted here: soft-deleted files stay for the audit trail
// and the weekly cleanup job hard-deletes them later (Gap 9).

export interface UrlOptions {
  filename: string;
  contentType: string;
  // attachment for user files (never rendered by the browser), inline for logos.
  disposition: 'attachment' | 'inline';
  expiresInSeconds?: number;
}

export interface StorageDriver {
  readonly kind: 's3' | 'local';
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  signedUrl(key: string, opts: UrlOptions): Promise<string>;
}

// RFC 6266: ASCII fallback plus the UTF-8 name.
export function contentDisposition(disposition: 'attachment' | 'inline', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ─── S3 ─────────────────────────────────────────────────────────────────────

class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  private client = new S3Client({
    region: env.AWS_S3_REGION,
    ...(env.AWS_S3_ENDPOINT ? { endpoint: env.AWS_S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.AWS_ACCESS_KEY_ID
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });

  async put(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }));
      return res.Body ? new Uint8Array(await res.Body.transformToByteArray()) : null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  signedUrl(key: string, opts: UrlOptions) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: contentDisposition(opts.disposition, opts.filename),
      }),
      { expiresIn: opts.expiresInSeconds ?? env.FILE_URL_TTL_SECONDS },
    );
  }
}

// ─── Local disk (dev) ───────────────────────────────────────────────────────

interface LocalGrant {
  k: string; // key
  f: string; // filename
  t: string; // content type
  d: 'attachment' | 'inline';
  e: number; // expiry, unix seconds
}

const signingKey = () => createHmac('sha256', env.JWT_SECRET).update('local-storage-urls').digest();
const sign = (payload: string) => createHmac('sha256', signingKey()).update(payload).digest('base64url');

export function verifyLocalGrant(token: string): LocalGrant | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalGrant;
    return grant.e * 1000 > Date.now() ? grant : null;
  } catch {
    return null;
  }
}

class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private root = path.resolve(env.LOCAL_STORAGE_DIR);

  // Keys are generated server-side, but never trust them to stay inside the root.
  private pathFor(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`storage key escapes root: ${key}`);
    return full;
  }

  async put(key: string, body: Uint8Array) {
    const full = this.pathFor(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async signedUrl(key: string, opts: UrlOptions) {
    const grant: LocalGrant = {
      k: key,
      f: opts.filename,
      t: opts.contentType,
      d: opts.disposition,
      e: Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? env.FILE_URL_TTL_SECONDS),
    };
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return `${env.API_PUBLIC_URL}/api/v1/storage/${payload}.${sign(payload)}`;
  }
}

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  driver ??= env.AWS_S3_BUCKET ? new S3Storage() : new LocalStorage();
  return driver;
}

// Tests swap in an in-memory driver.
export function setStorage(next: StorageDriver | null) {
  driver = next;
}
