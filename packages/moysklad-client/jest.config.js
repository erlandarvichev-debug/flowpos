module.exports = {
  displayName: 'moysklad-client',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@flowpos/moysklad-client$': '<rootDir>/src/index.ts',
  },
};
