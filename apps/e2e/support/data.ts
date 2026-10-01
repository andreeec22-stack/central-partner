import { execSync } from 'node:child_process';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL, E2E_DATABASE_URL } from './env';

const API_DIR = path.resolve(__dirname, '../../api');

// Rebuilds the demo workspace (apps/api/prisma/seed.ts): 13 areas, director,
// 4 heads, 4 collaborators, a viewer, 3 closed weeks and the current one.
export function reseed() {
  execSync('npx prisma migrate deploy', { cwd: API_DIR, env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL }, stdio: 'pipe' });
  execSync('npx tsx prisma/seed.ts', { cwd: API_DIR, env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL, NODE_ENV: 'development' }, stdio: 'pipe' });
}

// Demo accounts from the seed (all with the same password).
export const PASSWORD = 'demo-12345';
export const ACCOUNTS = {
  director: { email: 'director@central.local', name: 'Directora General', role: 'Director' },
  jefe: { email: 'jefe.marketing@central.local', name: 'Jefe Marketing', role: 'Jefe de área' },
  colaborador: { email: 'ana.gomez@central.local', name: 'Ana Gómez', role: 'Colaborador' },
  lector: { email: 'viewer@central.local', name: 'Lector', role: 'Lector' },
} as const;
export type Who = keyof typeof ACCOUNTS;

// Signs in through the login form, as a person would.
export async function login(page: Page, who: Who) {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(ACCOUNTS[who].email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText(ACCOUNTS[who].role, { exact: true }).first()).toBeVisible();
}

// Direct API access (what a client without the UI could try).
export async function token(request: APIRequestContext, who: Who): Promise<string> {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email: ACCOUNTS[who].email, password: PASSWORD } });
  expect(res.status(), `login ${who}`).toBe(200);
  return (await res.json()).accessToken as string;
}

export async function api(request: APIRequestContext, auth: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', urlPath: string, data?: unknown) {
  const res = await request.fetch(`${API_URL}${urlPath}`, { method, headers: { authorization: `Bearer ${auth}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

// "YYYY-MM-DD" of the Monday `weeksAgo` weeks before this one (Lima time).
export function mondayWeeksAgo(weeksAgo: number) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * weeksAgo);
  return d.toISOString().slice(0, 10);
}

// A past week nobody closed (the seed archives the last 3): it shows under
// "Semanas anteriores sin cerrar" and can be closed any day.
export async function openPastWeek(request: APIRequestContext, weeksAgo = 4) {
  const director = await token(request, 'director');
  const res = await api(request, director, 'POST', '/weeks', { mondayDate: mondayWeeksAgo(weeksAgo) });
  expect([200, 201]).toContain(res.status);
  return res.body.week as { id: string; weekNumber: number; mondayDate: string };
}

export async function findTask(request: APIRequestContext, auth: string, search: string) {
  const res = await api(request, auth, 'GET', `/tasks?search=${encodeURIComponent(search)}&limit=5`);
  expect(res.status).toBe(200);
  const task = res.body.data.find((t: { title: string }) => t.title === search);
  expect(task, `task "${search}"`).toBeTruthy();
  return task as { id: string; title: string; progress: number; updatedAt: string };
}

// How many audit entries of `action` the workspace has (ADMIN view).
export async function auditCount(request: APIRequestContext, action: string) {
  const director = await token(request, 'director');
  const res = await api(request, director, 'GET', `/audit-logs?action=${action}&limit=1`);
  expect(res.status).toBe(200);
  return res.body.total as number;
}

// Closes a week through the API as the director (force: areas may be incomplete).
export async function closeWeekViaApi(request: APIRequestContext, weekId: string) {
  const director = await token(request, 'director');
  const res = await api(request, director, 'POST', `/weeks/${weekId}/close`, { force: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { week: { id: string; weekNumber: number; status: string }; report: { id: string; filename: string; sheetCount: number } | null };
}
