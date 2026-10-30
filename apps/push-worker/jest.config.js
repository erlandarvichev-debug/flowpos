module.exports = {
  displayName: 'push-worker',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@flowpos/onec-client$': '<rootDir>/../../packages/onec-client/src/index.ts',
  },
};
