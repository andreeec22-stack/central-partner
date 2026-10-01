import { defineConfig, devices } from '@playwright/test';
import { API_PORT, E2E_DATABASE_URL, WEB_PORT } from './support/env';

// End-to-end tests in a real browser against a real API and database.
//
// Isolation: a database of its own (central_partner_e2e, created and migrated
// on start) and ports of their own (API 3002, web 5176), so a run never
// touches the dev data, the integration-test database (which TRUNCATEs) or
// the demo servers on 3001/5175. Data comes from the demo seed, reloaded by
// the specs that change it (support/data.ts → reseed).
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // One shared database: specs run one at a time, tests in order.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    headless: true,
    locale: 'es-PE',
    timezoneId: 'America/Lima',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Migrations first (creates the database the first time), then the API.
      command: 'npx prisma migrate deploy && npx tsx --env-file=.env src/index.ts',
      cwd: '../api',
      url: `http://localhost:${API_PORT}/health`,
      env: {
        ...process.env,
        DATABASE_URL: E2E_DATABASE_URL,
        PORT: String(API_PORT),
        APP_URL: `http://localhost:${WEB_PORT}`,
        API_PUBLIC_URL: `http://localhost:${WEB_PORT}`,
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        // Every test signs in through the form: lift the per-IP login limit.
        AUTH_RATE_LIMIT_MAX: '10000',
        RATE_LIMIT_MAX: '10000',
        LOCAL_STORAGE_DIR: 'uploads-e2e',
        // The seed (reloaded by specs) and the weekly scheduler would race on
        // the current week; the data is set up by the specs instead.
        SCHEDULERS_ENABLED: 'false',
        LOG_LEVEL: 'warn',
      },
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: '../web',
      url: `http://localhost:${WEB_PORT}`,
      env: { ...process.env, VITE_DEV_API_PROXY: `http://localhost:${API_PORT}` },
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
