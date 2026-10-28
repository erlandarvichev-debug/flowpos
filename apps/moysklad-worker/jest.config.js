module.exports = {
  displayName: 'moysklad-worker',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@flowpos/moysklad-client$': '<rootDir>/../../packages/moysklad-client/src/index.ts',
  },
};
