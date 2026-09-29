/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  clearMocks: true,
  // Integration hooks truncate and re-seed the DB; the first one also pays ts-jest compile time.
  testTimeout: 20_000,
};
