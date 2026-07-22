import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // action/ uses node:test rather than jest; its files get node
    // globals only so jest globals don't mask real undefined names.
    files: ['action/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // ui/ has its own eslint.config.js (browser + TS). action/node_modules
    // stays out; action/ source is linted by the root run.
    ignores: ['.aws-sam/**', 'coverage/**', 'node_modules/**', 'ui/**', 'action/node_modules/**'],
  },
];
