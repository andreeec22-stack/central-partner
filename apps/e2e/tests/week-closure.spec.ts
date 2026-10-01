import { expect, test, type Page } from '@playwright/test';
import { api, auditCount, login, openPastWeek, reseed, token, type Who } from '../support/data';

// Suite 3 · Closing a week (with its automatic Excel report)
test.describe.configure({ mode: 'serial' });

let week: { id: string; weekNumber: number; mondayDate: string };

test.beforeAll(async ({ request }) => {
  reseed();
  week = await openPastWeek(request, 4);
});

async function openCloseModal(page: Page, weekNumber: number) {
  await page.goto('/admin/weeks');
  const pending = page.getByRole('region', { name: 'Semanas anteriores sin cerrar' });
  const row = pending.getByRole('listitem').filter({ hasText: `S${weekNumber}` });
  await row.getByRole('button', { name: 'Cerrar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Paso 1 de 2 · Validación de completitud')).toBeVisible();
  return dialog;
}

test.describe('Cierre de semana', () => {
  test('el director ve la semana pendiente y el modal anuncia el reporte automático', async ({ page }) => {
    await login(page, 'director');
    const dialog = await openCloseModal(page, week.weekNumber);
    await expect(dialog.getByText(/reporte Excel de la semana se generará automáticamente/)).toBeVisible();
    await dialog.getByRole('button', { name: 'No, volver' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  for (const who of ['jefe', 'colaborador', 'lector'] as Who[]) {
    test(`${who} no puede cerrar la semana (403)`, async ({ request }) => {
      const res = await api(request, await token(request, who), 'POST', `/weeks/${week.id}/close`, { force: true });
      expect(res.status).toBe(403);
    });
  }

  test('al confirmar: se archiva, genera el reporte y ofrece descargarlo', async ({ page, request }) => {
    const closedBefore = await auditCount(request, 'WEEK_CLOSED');
    await login(page, 'director');
    const dialog = await openCloseModal(page, week.weekNumber);
    await dialog.getByRole('button', { name: /^(Cerrar semana|Sí, cerrar igual)$/ }).click();

    await expect(dialog.getByRole('heading', { name: `✅ Semana ${week.weekNumber} archivada` })).toBeVisible();
    await expect(dialog.getByText(/Reporte Excel generado \(\d+ hojas\)/)).toBeVisible();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Descargar Excel' }).click();
    expect((await download).suggestedFilename()).toMatch(new RegExp(`Semana${week.weekNumber}_\\d{4}\\.xlsx$`));

    // On the record.
    expect(await auditCount(request, 'WEEK_CLOSED')).toBe(closedBefore + 1);
    expect(await auditCount(request, 'REPORT_GENERATED')).toBeGreaterThanOrEqual(1);
  });

  test('tras el cierre, la semana ya no está pendiente y figura entre las archivadas', async ({ page }) => {
    await login(page, 'director');
    await page.goto('/admin/weeks');
    await expect(page.getByRole('region', { name: 'Semanas anteriores sin cerrar' })).toHaveCount(0);
    const archived = page.getByRole('table', { name: 'Semanas archivadas' });
    await expect(archived.getByRole('row', { name: new RegExp(`S${week.weekNumber}\\b`) })).toBeVisible();
  });

  test('las tareas de una semana cerrada son de solo lectura (UI y API)', async ({ page, request }) => {
    const director = await token(request, 'director');
    const archivedWeeks = await api(request, director, 'GET', '/weeks/archived?limit=20');
    const seeded = archivedWeeks.body.data.find((w: { id: string }) => w.id !== week.id);
    const tasks = await api(request, director, 'GET', `/tasks?weekId=${seeded.id}&limit=5`);
    const task = tasks.body.data[0] as { id: string; title: string };
    expect(task).toBeTruthy();

    const res = await api(request, director, 'PATCH', `/tasks/${task.id}`, { title: 'Cambio tardío' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WEEK_ARCHIVED');

    await login(page, 'director');
    await page.goto(`/tasks?week=all&task=${task.id}`);
    await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar título' })).toHaveCount(0);
  });

  test('si el reporte falla, el modal lo explica y la semana igual queda cerrada', async ({ page, request }) => {
    const other = await openPastWeek(request, 5);
    // Simulate the failure the API reports (report: null); the real failure
    // path is covered by apps/api/tests/integration/reports.test.ts.
    await page.route('**/api/v1/weeks/*/close', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { ...json, report: null } });
    });
    await login(page, 'director');
    const dialog = await openCloseModal(page, other.weekNumber);
    await dialog.getByRole('button', { name: /^(Cerrar semana|Sí, cerrar igual)$/ }).click();
    await expect(dialog.getByRole('heading', { name: `✅ Semana ${other.weekNumber} archivada` })).toBeVisible();
    await expect(dialog.getByText(/no se pudo generar/)).toBeVisible();

    const state = await api(request, await token(request, 'director'), 'GET', `/weeks/${other.id}`);
    expect(state.body.week.status).toBe('ARCHIVED');
  });
});
