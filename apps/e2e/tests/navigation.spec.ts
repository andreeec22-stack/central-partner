import { expect, test } from '@playwright/test';
import { api, login, token, type Who } from '../support/data';

// Suite 2 · Navigation and what each role sees
test.describe('Navegación y visibilidad', () => {
  test('el director ve "Reportes semanales" y entra a la página', async ({ page }) => {
    await login(page, 'director');
    const link = page.getByRole('navigation', { name: 'Administración' }).getByRole('link', { name: 'Reportes semanales' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/admin\/reports$/);
    await expect(page.getByRole('heading', { name: 'Reportes semanales' })).toBeVisible();
  });

  for (const who of ['jefe', 'colaborador', 'lector'] as Who[]) {
    test(`${who}: no ve Administración y /admin/reports lo devuelve al inicio (API 403)`, async ({ page, request }) => {
      await login(page, who);
      await expect(page.getByRole('navigation', { name: 'Administración' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Reportes semanales' })).toHaveCount(0);
      await page.goto('/admin/reports');
      await expect(page).toHaveURL(/\/$/);
      expect((await api(request, await token(request, who), 'GET', '/export')).status).toBe(403);
    });
  }

  test('las semanas archivadas se muestran en solo lectura, sin botón de cierre', async ({ page }) => {
    await login(page, 'director');
    await page.goto('/admin/weeks');
    const archived = page.getByRole('table', { name: 'Semanas archivadas' });
    await expect(archived.getByRole('row')).toHaveCount(4); // header + 3 closed weeks from the seed
    await expect(archived.getByRole('button', { name: /Cerrar/ })).toHaveCount(0);
    await expect(archived.getByRole('button', { name: /Excel/ }).first()).toBeVisible();
  });

  test('el lector no ve la sección Desempeño', async ({ page }) => {
    await login(page, 'lector');
    await expect(page.getByRole('link', { name: 'Desempeño' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Tareas' })).toBeVisible();
  });
});
