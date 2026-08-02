import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * API lint (wave P1). The web workspace lints with eslint-config-next; the
 * API uses typescript-eslint recommended with pragmatic relaxations that
 * match the existing codebase style (explicit any tolerated at provider
 * boundaries, unused vars only flagged outside _-prefixed args).
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', '*.ts'],
    linterOptions: {
      // The codebase carries targeted disables for rules relaxed below.
      reportUnusedDisableDirectives: 'off'
    },
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        RequestInit: 'readonly',
        DOMException: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
);
