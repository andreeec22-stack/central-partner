import { statSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { expect, test } from '@playwright/test';
import { auditCount, closeWeekViaApi, login, openPastWeek, reseed } from '../support/data';

// Suites 4 & 5 · The weekly Excel report: content, download and management
test.describe.configure({ mode: 'serial' });

const AREAS = 13; // the demo seed's departments
let week: { id: string; weekNumber: number };
let workbook: ExcelJS.Workbook;
let fileSize = 0;

const text = (ws: ExcelJS.Worksheet | undefined) => JSON.stringify(ws?.getSheetValues() ?? []);

test.beforeAll(async ({ request }) => {
  reseed();
  week = await openPastWeek(request, 4);
  const closed = await closeWeekViaApi(request, week.id);
  expect(closed.report, 'automatic report on close').not.toBeNull();
});

test.describe('Reporte Excel', () => {
  test('se generó al cerrar la semana y aparece en Reportes semanales', async ({ page }) => {
    await login(page, 'director');
    await page.goto('/admin/reports');
    const row = page.getByRole('table', { name: 'Reportes semanales' }).getByRole('row').filter({ hasText: `Semana ${week.weekNumber}` });
    await expect(row).toContainText('Cierre de semana');
    await expect(row).toContainText('Disponible');
  });

  test('el director lo descarga desde la página y queda en auditoría', async ({ page, request }) => {
    const before = await auditCount(request, 'REPORT_DOWNLOADED');
    await login(page, 'director');
    await page.goto('/admin/reports');
    const row = page.getByRole('row').filter({ hasText: `Semana ${week.weekNumber}` });
    const download = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Descargar' }).click();
    const file = await download;
    const path = await file.path();
    fileSize = statSync(path).size;
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    expect(await auditCount(request, 'REPORT_DOWNLOADED')).toBe(before + 1);
  });

  test('tiene resumen, una hoja por área, histórico y notas', () => {
    const names = workbook.worksheets.map((w) => w.name);
    expect(names).toHaveLength(AREAS + 3);
    expect(names[0]).toBe('Resumen');
    expect(names.slice(-2)).toEqual(['Histórico', 'Notas']);
  });

  test('el resumen trae top 3 y bottom 3 de áreas', () => {
    const summary = text(workbook.getWorksheet('Resumen'));
    for (const block of ['Top 3 áreas', 'Bottom 3 áreas', 'Todas las áreas', 'Tendencia semanal (índice total)', 'Índice total']) {
      expect(summary).toContain(block);
    }
  });

  test('cada área trae índice, últimas 12 semanas, KPIs y funciones', () => {
    const marketing = text(workbook.getWorksheet('Marketing'));
    for (const block of ['Índice', 'Índice de las últimas 12 semanas', 'Tareas pendientes críticas (vencidas o bloqueadas)', 'KPIs', 'Funciones']) {
      expect(marketing).toContain(block);
    }
  });

  test('acentos y ñ se conservan', () => {
    const names = workbook.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Diseño', 'Diseño Audiovisual', 'RRHH - Nómina', 'Tesorería', 'Auditoría y Calidad']));
    expect(text(workbook.getWorksheet('Notas'))).toContain('Directora General');
  });

  test('pesa menos de 10 MB (E2.1)', () => {
    expect(fileSize).toBeGreaterThan(0);
    expect(fileSize).toBeLessThan(10 * 1024 * 1024);
  });

  test('el director lo elimina (soft delete) y lo restaura', async ({ page }) => {
    await login(page, 'director');
    await page.goto('/admin/reports');
    const table = page.getByRole('table', { name: 'Reportes semanales' });
    await table.getByRole('button', { name: `Eliminar reporte de la semana ${week.weekNumber}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByText('Aún no hay reportes')).toBeVisible();

    await page.getByLabel('Ver eliminados y vencidos').check();
    const row = page.getByRole('row').filter({ hasText: `Semana ${week.weekNumber}` });
    await expect(row).toContainText('Eliminado');
    await row.getByRole('button', { name: 'Restaurar' }).click();
    await expect(row).toContainText('Disponible');
  });

  test('el director regenera el reporte de una semana cerrada', async ({ page }) => {
    await login(page, 'director');
    await page.goto('/admin/reports');
    await page.getByRole('combobox', { name: 'Semana cerrada' }).selectOption(week.id);
    await page.getByRole('button', { name: 'Generar de nuevo' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Manual' })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: `Semana ${week.weekNumber}` })).toHaveCount(2);
  });
});
