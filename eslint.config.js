import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['bin/**', 'node_modules/**']),
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Express error handlers need all four arguments even when `next` is unused.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },
]);
