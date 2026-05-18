export default {
  transform: {
    '^.+\\.[tj]sx?$': 'babel-jest'
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@aws-sdk))'
  ],
  testMatch: [
    '**/__tests__/**/*.[j]s?(x)',
    '**/?(*.)+(spec|test).[j]s?(x)',
    '**/?(*.)+(spec|test).mjs'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.aws-sam/'
  ],
  testEnvironment: 'node'
};
