import nextConfig from 'eslint-config-next';

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ['.next/**', 'node_modules/**', 'public/sw.js'],
    rules: {
      // These hooks intentionally hydrate from localStorage after first render to
      // avoid SSR/client markup mismatches for offline drafts and role state.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      // jsx-a11y: eslint-config-next 16 bundles the plugin but enables only
      // alt-text/aria-props/aria-proptypes/aria-unsupported-elements/
      // role-has-required-aria-props/role-supports-aria-props (as warnings).
      // Gap rules below fill the interaction/labelling holes for the a11y wave.
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/no-access-key': 'error',
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/no-distracting-elements': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/tabindex-no-positive': 'error'
    }
  }
];

export default eslintConfig;
