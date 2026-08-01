import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // SWC is required so NestJS decorator metadata (emitDecoratorMetadata) is emitted in tests.
    swc.vite({ module: { type: 'es6' } })
  ],
  resolve: {
    alias: {
      '@agric-platform/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url)
      )
    }
  },
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node'
  }
});
