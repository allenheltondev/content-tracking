export default {
  transform: {
    '^.+\\.[tj]sx?$': 'babel-jest',
    '^.+\\.html$': '<rootDir>/jest-html-transformer.cjs'
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
    '/.aws-sam/',
    // The GitHub Action is a self-contained npm project with its own deps and
    // uses node:test (run via `npm test` inside action/), not this jest config.
    '/action/'
  ],
  testEnvironment: 'node'
};
