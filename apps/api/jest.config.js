module.exports = {
  displayName: 'api',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@flowpos/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
  },
  globals: {
    'ts-jest': {
      diagnostics: {
        ignoreCodes: [2339, 2551, 2561, 2345, 2353, 2322, 2349],
      },
    },
  },
};
