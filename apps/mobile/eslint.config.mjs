import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Mobile lint — mirrors apps/api's flat config (typescript-eslint
 * recommended with pragmatic relaxations) and also covers .tsx screens.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'coverage/**', '.expo/**', 'dist/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['*.js'],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly'
      }
    }
  },
  {
    // Node build tooling (icon generator) — not bundled into the app.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}', 'App.tsx', '*.{ts,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        RequestInit: 'readonly',
        RequestInfo: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        crypto: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
);
