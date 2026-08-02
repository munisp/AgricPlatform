import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * API lint (Wave P3): flat config over eslint + typescript-eslint
 * recommended (non-type-checked so it stays fast and needs no project
 * service). TypeScript correctness is enforced separately by
 * `npm run typecheck -w apps/api`.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      // NestJS uses empty constructors for DI-only classes.
      'no-useless-constructor': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // ignoreRestSiblings covers the `const { hash, ...rest } = event`
      // omit-via-destructure idiom.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },
  {
    // Pre-existing violations in modules owned by other waves (frozen for
    // Wave P3). Tracked for the owning waves to clean up; do not extend.
    files: [
      'src/database/repositories/marketplace.pg-repository.ts',
      'src/modules/notifications/notifications.controller.ts'
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off'
    }
  }
];
