module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tools', '<rootDir>/bots'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs', esModuleInterop: true, isolatedModules: true } }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
}
