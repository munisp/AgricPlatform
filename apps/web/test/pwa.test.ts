import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guards for the PWA surface (no browser available — the service
 * worker lifecycle itself is external verification). These assert the
 * offline fallback wiring, the message-gated update flow, cache eviction
 * and manifest installability entries as text/JSON structure.
 */

// vitest runs with cwd = apps/web.
const sw = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8')
) as { icons: { src: string; sizes: string; purpose: string }[] };
const swRegister = readFileSync(
  resolve(process.cwd(), 'components/sw-register.tsx'),
  'utf8'
);

describe('service worker (static guards)', () => {
  it('precaches /offline in the app shell', () => {
    const appShell = sw.match(/APP_SHELL\s*=\s*\[([^\]]*)\]/);
    expect(appShell?.[1]).toContain("'/offline'");
  });

  it('falls back to /offline for failed navigations', () => {
    expect(sw).toContain("caches.match('/offline')");
  });

  it('caps the page cache with FIFO eviction', () => {
    expect(sw).toContain('PAGE_CACHE_LIMIT');
    expect(sw).toContain('trimCache(PAGE_CACHE, PAGE_CACHE_LIMIT)');
  });

  it('never calls skipWaiting unconditionally — updates are message-gated', () => {
    // The only skipWaiting call must live inside the SKIP_WAITING message handler.
    const calls = sw.match(/self\.skipWaiting\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(sw).toContain("event.data && event.data.type === 'SKIP_WAITING'");
    // And the install listener body must not contain it (no unconditional activation).
    const installBody = sw
      .match(/addEventListener\('install'[\s\S]*?\n\}\);/)?.[0]
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(installBody).not.toContain('skipWaiting()');
  });

  it('returns a real Response for failed non-navigation fetches', () => {
    expect(sw).toContain('Response.error()');
    // /api/* offline with no cache: 504 JSON, never undefined.
    expect(sw).toContain('status: 504');
    expect(sw).not.toMatch(/catch\(function \(\) \{\s*return cached;\s*\}\)/);
  });
});

describe('sw-register update banner (static guards)', () => {
  it('announces updates via a role=status banner and posts SKIP_WAITING', () => {
    expect(swRegister).toContain('role="status"');
    expect(swRegister).toContain("postMessage({ type: 'SKIP_WAITING' })");
    expect(swRegister).toContain('controllerchange');
  });
});

describe('web app manifest', () => {
  it('declares PNG icons at 192 and 512 for installability (any + maskable)', () => {
    for (const size of ['192x192', '512x512']) {
      for (const purpose of ['any', 'maskable']) {
        const icon = manifest.icons.find(
          (entry) => entry.sizes === size && entry.purpose === purpose
        );
        expect(icon, `${size} ${purpose} icon missing`).toBeTruthy();
        expect(icon!.src).toMatch(/\.png$/);
      }
    }
    // NOTE: public/icon-192.png and public/icon-512.png are declared here but
    // the binary assets are produced externally (design task) — installability
    // must be re-verified on a real device once they land.
  });
});
