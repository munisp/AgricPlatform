import nextConfig from 'eslint-config-next';

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ['.next/**', 'node_modules/**', 'public/sw.js'],
    rules: {
      // These hooks intentionally hydrate from localStorage after first render to
      // avoid SSR/client markup mismatches for offline drafts and role state.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off'
    }
  }
];

export default eslintConfig;
