/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // Separate from tsconfig.json: that one scopes "types" to
        // ["node", "electron"] so main/preload code doesn't accidentally
        // see Jest's globals, but that also hides them from the tests
        // themselves. This config adds "jest" back for __tests__ only.
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
};
