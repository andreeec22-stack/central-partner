// Loaded before every test file (jest setupFiles), before any app module reads env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://central:central@localhost:5432/central_partner_test';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.BCRYPT_ROUNDS = '4';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.TRUST_PROXY = 'true'; // tests identify clients via X-Forwarded-For
// Files written by code under test (e.g. weekly reports on week close) never land in the dev uploads/ folder.
process.env.LOCAL_STORAGE_DIR = require('node:path').join(require('node:os').tmpdir(), 'central-partner-test-uploads');
