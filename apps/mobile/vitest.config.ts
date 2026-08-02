import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests run under vitest with react-test-renderer (NOT jest-expo — see
 * README.md for the rationale). `react-native` is aliased to a lightweight
 * manual mock so screens render in plain Node without the Metro transform.
 * react + react-test-renderer are pinned to the same version so components
 * and the renderer share one React instance.
 */
export default defineConfig({
  resolve: {
    alias: {
      'react-native': fileURLToPath(new URL('./test/mocks/react-native.tsx', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}']
  }
});
