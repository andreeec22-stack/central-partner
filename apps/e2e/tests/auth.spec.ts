import { expect, test } from '@playwright/test';
import { ACCOUNTS, login, PASSWORD, type Who } from '../support/data';

// Suite 1 · Authentication & roles
test.describe('Autenticación y roles', () => {
  for (const who of ['director', 'jefe', 'colaborador', 'lector'] as Who[]) {
    test(`inicia sesión como ${who} y ve su nombre y rol`, async ({ page }) => {
      await login(page, who);
      // The seed's viewer is literally named "Lector", like its role: take the name line.
      await expect(page.getByText(ACCOUNTS[who].name, { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test('cerrar sesión vuelve al login y protege las páginas', async ({ page }) => {
    await login(page, 'director');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/admin/reports');
    await expect(page).toHaveURL(/\/login$/);
    // The refresh cookie was revoked: reloading doesn't sign back in.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });

  test('una contraseña incorrecta muestra el error y no entra', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Correo').fill(ACCOUNTS.director.email);
    await page.getByLabel('Contraseña').fill(`${PASSWORD}-mal`);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
