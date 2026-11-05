import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      'apps/api/public/**',
      '**/*.d.ts',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker } },
    rules: {
      // Tüm dış istekler apps/api/src/publish/http.ts üzerinden geçmeli.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Doğrudan fetch yasak: publish/http.ts istemcisini kullanın.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'globalThis',
          property: 'fetch',
          message: 'Doğrudan fetch yasak: publish/http.ts.',
        },
        { object: 'self', property: 'fetch', message: 'Doğrudan fetch yasak: publish/http.ts.' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.config.{js,ts}', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
