/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setEnv.ts'],
  moduleDirectories: ['<rootDir>', 'src', 'node_modules'],
};
