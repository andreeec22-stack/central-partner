import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { contentDisposition } from '../../lib/storage';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import * as reports from './reports.service';

const reportId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Report');

const generateSchema = z.object({
  weekId: z.string().uuid(),
  // Only xlsx: a multi-sheet report has no CSV equivalent.
  format: z.string().default('xlsx'),
});

// Mounted under /export. ADMIN only (E2.4).
export const reportRoutes = new Hono<AppEnv>()
  .use('*', requireAuth, requireRole('ADMIN'))
  .post('/generate-weekly', async (c) => {
    const user = c.get('user');
    const { weekId, format } = await parseJson(c, generateSchema);
    if (format !== 'xlsx') throw new AppError(422, 'INVALID_FORMAT', 'Formato no soportado: solo xlsx', { supported: ['xlsx'] });
    const report = await reports.generateManualReport(user, weekId, clientContext(c).ipAddress);
    const view = reports.presentReport(report);
    return c.json({ success: true, exportId: view.id, downloadUrl: view.downloadUrl, expiresAt: view.expiresAt, size: view.sizeBytes, report: view }, 201);
  })
  // The week's report from the fastest source: cache → stored file → generate.
  .post('/week-report', async (c) => {
    const { weekId } = parseQuery(c, z.object({ weekId: z.string().uuid() }));
    const { data, filename, source } = await reports.weekReport(c.get('user'), weekId, clientContext(c).ipAddress);
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': reports.XLSX_TYPE,
      'Content-Disposition': contentDisposition('attachment', filename),
      'Cache-Control': 'private, no-store',
      'X-Report-Source': source,
    });
  })
  .get('/', async (c) => {
    const q = parseQuery(c, z.object({ weekId: z.string().uuid().optional(), includeDeleted: z.enum(['true', 'false']).default('false') }));
    return c.json(await reports.listReports(c.get('user'), { weekId: q.weekId, includeDeleted: q.includeDeleted === 'true' }));
  })
  .get('/:id/download', async (c) => {
    const { bytes, filename } = await reports.downloadReport(c.get('user'), reportId(c), clientContext(c).ipAddress);
    return c.body(bytes, 200, {
      'Content-Type': reports.XLSX_TYPE,
      'Content-Disposition': contentDisposition('attachment', filename),
      // Confidential: never cached by the browser or any proxy.
      'Cache-Control': 'private, no-store',
    });
  })
  .delete('/:id', async (c) => c.json(await reports.deleteReport(c.get('user'), reportId(c), clientContext(c).ipAddress)))
  .post('/:id/restore', async (c) => c.json(await reports.restoreReport(c.get('user'), reportId(c), clientContext(c).ipAddress)));
