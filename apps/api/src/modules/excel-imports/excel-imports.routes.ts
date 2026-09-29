import { Hono } from 'hono';
import { EXCEL_FILE_TYPES } from '../../lib/file-types';
import { readUpload, uploadLimit } from '../../lib/upload';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import { confirmImportSchema, listImportsSchema } from './excel-imports.schemas';
import * as imports from './excel-imports.service';

const importId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Import');

// ADMIN only, end to end.
export const excelImportRoutes = new Hono<AppEnv>()
  .use('*', requireAuth, requireRole('ADMIN'))
  .get('/', async (c) => c.json(await imports.listImports(c.get('user'), parseQuery(c, listImportsSchema))))
  .post('/upload', uploadLimit(imports.MAX_EXCEL_BYTES), async (c) => {
    const upload = await readUpload(c, { maxBytes: imports.MAX_EXCEL_BYTES, allowed: EXCEL_FILE_TYPES, allowedLabel: 'xlsx' });
    return c.json(await imports.uploadImport(c.get('user'), upload, clientContext(c)), 201);
  })
  .get('/:id', async (c) => c.json(await imports.getImport(c.get('user'), importId(c))))
  .post('/:id/confirm', async (c) => {
    const id = importId(c);
    const input = await parseJson(c, confirmImportSchema);
    return c.json(await imports.confirmImport(c.get('user'), id, input, clientContext(c)));
  })
  .delete('/:id', async (c) => {
    await imports.discardImport(c.get('user'), importId(c));
    return c.json({ success: true });
  });
