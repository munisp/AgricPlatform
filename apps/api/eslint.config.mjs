import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Constructor parameter properties and Nest DI metadata trip the
      // base no-unused-vars rule; keep the TS-aware variant. Warning level:
      // the API predates this config and a few legacy violations remain in
      // modules owned by other waves.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // DTO classes use definite-assignment properties.
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
);
