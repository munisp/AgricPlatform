import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { assertSeedEnvironment } from './seed.js';

const execFileAsync = promisify(execFile);

// tsx is a devDependency of this workspace; npm may hoist its bin to the
// repo-root node_modules. Resolve whichever exists.
const TSX_BIN = [
  fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url)),
  fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url)),
  fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url))
].find((candidate) => existsSync(candidate));

// The spawned CLI is a separate Node process WITHOUT the vitest alias that
// maps @agric-platform/shared to source — it resolves the package main
// (dist/index.js). The unit-test CI job never builds packages/shared, so the
// e2e spawn can only run where a dist build exists. The unit test above pins
// the guard logic regardless of environment.
const SHARED_DIST = [
  fileURLToPath(
    new URL('../../node_modules/@agric-platform/shared/dist/index.js', import.meta.url)
  ),
  fileURLToPath(
    new URL('../../../node_modules/@agric-platform/shared/dist/index.js', import.meta.url)
  ),
  fileURLToPath(
    new URL('../../../../node_modules/@agric-platform/shared/dist/index.js', import.meta.url)
  )
].find((candidate) => existsSync(candidate));

/**
 * OB-13: the seed CLI loads DEMO data (test identities, demo listings, a
 * certificate counter baseline) and must refuse to run in production.
 */
describe('seed CLI production guard (OB-13)', () => {
  it('assertSeedEnvironment throws in production, passes otherwise', () => {
    expect(() => assertSeedEnvironment({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /refusing to seed/
    );
    // Fail-closed normalisation lives in isProduction(): casing/whitespace
    // variants must also be refused.
    expect(() => assertSeedEnvironment({ NODE_ENV: ' Production ' } as NodeJS.ProcessEnv)).toThrow(
      /refusing to seed/
    );
    expect(() =>
      assertSeedEnvironment({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() => assertSeedEnvironment({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('the CLI exits non-zero with a clear message when NODE_ENV=production', async (context) => {
    if (!TSX_BIN || !SHARED_DIST) {
      // tsx or the shared dist build not present in this environment — the
      // unit test above still pins the guard logic; the CLI path is covered
      // by npm run seed in environments that build the workspace.
      context.skip();
      return;
    }
    // End-to-end: run the real CLI entry (no DATABASE_URL needed — the
    // production guard fires before any database connection).
    const seedEntry = fileURLToPath(new URL('./seed.ts', import.meta.url));
    await expect(
      execFileAsync(TSX_BIN, [seedEntry], {
        env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgres://unused' }
      })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('refusing to seed')
    });
  }, 30_000);
});
