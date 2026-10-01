import { expect, test } from '@playwright/test';
import { api, closeWeekViaApi, openPastWeek, reseed, token, type Who } from '../support/data';
import { API_URL } from '../support/env';

// Suite 6 · Report permissions, checked against the API itself (what a client
// without the UI could try). The prompt's "/admin/reports/list" is a UI route;
// the data lives behind /api/v1/export.
test.describe.configure({ mode: 'serial' });

let reportId: string;
let weekId: string;

test.beforeAll(async ({ request }) => {
  reseed();
  const week = await openPastWeek(request, 4);
  weekId = week.id;
  reportId = (await closeWeekViaApi(request, week.id)).report!.id;
});

test.describe('Permisos de reportes', () => {
  test('el director lista los reportes', async ({ request }) => {
    const list = await api(request, await token(request, 'director'), 'GET', '/export');
    expect(list.status).toBe(200);
    const report = list.body.data.find((r: { id: string }) => r.id === reportId);
    expect(report).toMatchObject({ status: 'AVAILABLE', source: 'WEEK_CLOSED', downloadUrl: `/api/v1/export/${reportId}/download` });
  });

  for (const who of ['jefe', 'colaborador', 'lector'] as Who[]) {
    test(`${who}: 403 al listar, descargar, eliminar o generar`, async ({ request }) => {
      const auth = await token(request, who);
      expect((await api(request, auth, 'GET', '/export')).status).toBe(403);
      expect((await api(request, auth, 'GET', `/export/${reportId}/download`)).status).toBe(403);
      expect((await api(request, auth, 'DELETE', `/export/${reportId}`)).status).toBe(403);
      expect((await api(request, auth, 'POST', '/export/generate-weekly', { weekId })).status).toBe(403);
    });
  }

  test('la descarga del director entrega un .xlsx privado, sin caché', async ({ request }) => {
    const auth = await token(request, 'director');
    const res = await request.get(`${API_URL}/export/${reportId}/download`, { headers: { authorization: `Bearer ${auth}` } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('spreadsheetml');
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect((await res.body()).subarray(0, 2).toString()).toBe('PK'); // a zip container, as every .xlsx
  });
});
