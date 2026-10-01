import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, findTask, login, reseed, token, type Who } from '../support/data';

// Suite 7 · Edit conflicts: optimistic concurrency, first write wins.
// A (the Marketing head) and B (Ana, the assignee) have the same task open.
// B's live updates are cut (WebSocket mocked) so B keeps the stale version
// on screen, as happens when two people edit within the same seconds.
test.describe.configure({ mode: 'serial' });

const TITLE = 'Publicar 5 posts'; // seed: Marketing, assigned to Ana, 75%

test.beforeAll(() => reseed());

async function openTask(browser: Browser, who: Who, taskId: string, offline = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (offline) await page.routeWebSocket(/socket\.io/, () => undefined);
  await login(page, who);
  await page.goto(`/tasks?week=all&task=${taskId}`);
  const panel = page.getByRole('complementary', { name: 'Detalle de la tarea' });
  await expect(panel.getByRole('group', { name: 'Progreso' })).toBeVisible();
  return { page, panel, close: () => context.close() };
}

const saved = (page: Page, taskId: string) =>
  page.waitForResponse((r) => r.url().endsWith(`/api/v1/tasks/${taskId}`) && r.request().method() === 'PATCH');

test.describe('Conflictos de edición', () => {
  test('B guarda sobre una versión vieja: recibe el diálogo y A conserva su cambio', async ({ browser, request }) => {
    const task = await findTask(request, await token(request, 'jefe'), TITLE);
    const a = await openTask(browser, 'jefe', task.id);
    const b = await openTask(browser, 'colaborador', task.id, true);

    // A renames the task first.
    await a.panel.getByRole('button', { name: 'Editar título' }).click();
    await a.panel.getByLabel('título').fill('Publicar 5 posts (revisado)');
    const aSave = saved(a.page, task.id);
    await a.panel.getByLabel('título').press('Enter');
    expect((await aSave).status()).toBe(200);

    // B, still looking at the old version, moves the progress.
    const bSave = saved(b.page, task.id);
    await b.panel.getByRole('group', { name: 'Progreso' }).getByRole('button', { name: '50%' }).click();
    expect((await bSave).status()).toBe(409);
    const dialog = b.page.getByRole('dialog', { name: 'Cambios en conflicto' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Otra persona guardó esta tarea antes que tú');

    // First write wins: A's title stands, B's progress was not applied.
    const now = await findTask(request, await token(request, 'jefe'), 'Publicar 5 posts (revisado)');
    expect(now.progress).toBe(75);

    await a.close();
    await b.close();
  });

  test('B recarga, ve la versión de A y puede guardar su cambio', async ({ browser, request }) => {
    const task = await findTask(request, await token(request, 'jefe'), 'Publicar 5 posts (revisado)');
    const b = await openTask(browser, 'colaborador', task.id, true);
    // Someone else changes the task behind B's back.
    const jefe = await token(request, 'jefe');
    expect((await api(request, jefe, 'PATCH', `/tasks/${task.id}`, { title: 'Publicar 6 posts', expectedUpdatedAt: task.updatedAt })).status).toBe(200);

    await b.panel.getByRole('group', { name: 'Progreso' }).getByRole('button', { name: '50%' }).click();
    const dialog = b.page.getByRole('dialog', { name: 'Cambios en conflicto' });
    await dialog.getByRole('button', { name: 'Recargar' }).click();
    await expect(dialog).toBeHidden();
    await expect(b.panel.getByRole('button', { name: 'Editar título' })).toContainText('Publicar 6 posts');

    const bSave = saved(b.page, task.id);
    await b.panel.getByRole('group', { name: 'Progreso' }).getByRole('button', { name: '50%' }).click();
    expect((await bSave).status()).toBe(200);
    expect((await findTask(request, jefe, 'Publicar 6 posts')).progress).toBe(50);
    await b.close();
  });

  test('la misma persona guarda dos cambios seguidos sin conflicto', async ({ browser, request }) => {
    const task = await findTask(request, await token(request, 'jefe'), 'Publicar 6 posts');
    const a = await openTask(browser, 'jefe', task.id);
    const progress = a.panel.getByRole('group', { name: 'Progreso' });
    const responses: number[] = [];
    a.page.on('response', (r) => {
      if (r.url().endsWith(`/api/v1/tasks/${task.id}`) && r.request().method() === 'PATCH') responses.push(r.status());
    });
    // Two quick clicks: the second is sent before the first one answers.
    await progress.getByRole('button', { name: '75%' }).click();
    await progress.getByRole('button', { name: '100%' }).click();
    await expect.poll(() => responses.length).toBe(2);
    expect(responses).toEqual([200, 200]);
    await expect(a.page.getByRole('dialog', { name: 'Cambios en conflicto' })).toHaveCount(0);
    expect((await findTask(request, await token(request, 'jefe'), 'Publicar 6 posts')).progress).toBe(100);
    await a.close();
  });
});
