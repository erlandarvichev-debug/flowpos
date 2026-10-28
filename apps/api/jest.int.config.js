// Интеграционные тесты бухгалтерского ядра на реальной PostgreSQL (БД flowpos_test).
module.exports = {
  displayName: 'api-int',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
  setupFiles: ['<rootDir>/test/int-env.js'],
  testTimeout: 60000,
};
