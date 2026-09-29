/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  clearMocks: true,
};
