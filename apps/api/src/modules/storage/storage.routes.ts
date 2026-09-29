import { Hono } from 'hono';
import { notFound } from '../../lib/errors';
import { contentDisposition, getStorage, verifyLocalGrant } from '../../lib/storage';
import type { AppEnv } from '../../types';

// Public: serves local-storage objects behind the HMAC-signed, expiring links
// issued by lib/storage (dev fallback for S3 presigned URLs). The signature is
// the credential, so no auth header is needed — like an S3 presigned URL.
export const storageRoutes = new Hono<AppEnv>().get('/:token', async (c) => {
  const grant = verifyLocalGrant(c.req.param('token'));
  if (!grant || getStorage().kind !== 'local') throw notFound('File');
  const bytes = await getStorage().get(grant.k);
  if (!bytes) throw notFound('File');
  return c.body(bytes, 200, {
    'Content-Type': grant.t,
    'Content-Disposition': contentDisposition(grant.d, grant.f),
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    // Even if a file were rendered, it gets no scripts and no same-origin access.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  });
});
