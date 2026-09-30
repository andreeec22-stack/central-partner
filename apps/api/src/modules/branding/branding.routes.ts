import { Hono } from 'hono';
import { z } from 'zod';
import { notFound, validationError } from '../../lib/errors';
import { extensionOf, LOGO_FILE_TYPES } from '../../lib/file-types';
import { getStorage } from '../../lib/storage';
import { readUpload, uploadLimit } from '../../lib/upload';
import { idParam, parseJson } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import { prisma } from '../../lib/prisma';
import { isValidTimeZone } from '../../lib/time';
import { ActivityAction, logActivity } from '../audit/activity-log';
import { updateBrandingSchema } from './branding.schemas';
import * as branding from './branding.service';

const workspaceId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Workspace');

export const brandingRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/:id/branding', async (c) => c.json(await branding.getBranding(c.get('user'), workspaceId(c))))
  .patch('/:id/branding', requireRole('ADMIN'), async (c) => {
    const input = await parseJson(c, updateBrandingSchema);
    return c.json(await branding.updateBranding(c.get('user'), workspaceId(c), input, clientContext(c)));
  })
  .post('/:id/branding/logo/upload', requireRole('ADMIN'), uploadLimit(branding.MAX_LOGO_BYTES), async (c) => {
    const id = workspaceId(c);
    const upload = await readUpload(c, { maxBytes: branding.MAX_LOGO_BYTES, allowed: LOGO_FILE_TYPES, allowedLabel: 'png, jpg, svg' });
    return c.json(await branding.uploadLogo(c.get('user'), id, upload, clientContext(c)), 201);
  })
  .delete('/:id/branding/logo', requireRole('ADMIN'), async (c) =>
    c.json(await branding.removeLogo(c.get('user'), workspaceId(c), clientContext(c))),
  )
  // The timezone defines the workspace's weeks (Monday–Saturday) and "today".
  .get('/:id/settings', async (c) => {
    const user = c.get('user');
    if (workspaceId(c) !== user.workspaceId) throw notFound('Workspace');
    return c.json({ settings: { timezone: user.workspaceTimezone } });
  })
  .patch('/:id/settings', requireRole('ADMIN'), async (c) => {
    const user = c.get('user');
    if (workspaceId(c) !== user.workspaceId) throw notFound('Workspace');
    const { timezone } = await parseJson(c, z.object({ timezone: z.string().min(1).max(50) }));
    if (!isValidTimeZone(timezone)) throw validationError('Unknown timezone', [{ field: 'timezone', message: 'invalid' }]);
    await prisma.workspace.update({ where: { id: user.workspaceId }, data: { timezone } });
    await logActivity({
      workspaceId: user.workspaceId,
      userId: user.id,
      action: ActivityAction.WORKSPACE_SETTINGS_UPDATED,
      entityType: 'Workspace',
      entityId: user.workspaceId,
      changes: { timezone: { old: user.workspaceTimezone, new: timezone } },
      ipAddress: clientContext(c).ipAddress,
    });
    return c.json({ settings: { timezone } });
  });

const LOGO_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };

// Public: the logo is shown in <img> tags (and on the login screen), which
// can't carry a bearer token. The URL is versioned, so it caches well.
export const publicBrandingRoutes = new Hono<AppEnv>().get('/workspaces/:id/logo', async (c) => {
  const key = await branding.findLogo(workspaceId(c));
  if (!key) throw notFound('Logo');
  const contentType = LOGO_MIME[extensionOf(key)] ?? 'application/octet-stream';
  const storage = getStorage();
  if (storage.kind === 's3') {
    const url = await storage.signedUrl(key, { filename: key.split('/').pop()!, contentType, disposition: 'inline', expiresInSeconds: 3600 });
    c.header('Cache-Control', 'public, max-age=300');
    return c.redirect(url, 302);
  }
  const bytes = await storage.get(key);
  if (!bytes) throw notFound('Logo');
  return c.body(bytes, 200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
});
