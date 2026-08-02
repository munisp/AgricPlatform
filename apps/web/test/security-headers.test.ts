import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

/** Build-time assertion that the security header baseline stays configured. */
describe('next.config security headers', () => {
  it('sets CSP, nosniff, referrer and permissions policies on all routes', async () => {
    const rules = await nextConfig.headers!();
    const global = rules.find((rule) => rule.source === '/:path*');
    expect(global).toBeTruthy();

    const headers = new Map(global!.headers.map((h) => [h.key, h.value]));

    const csp = headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' http://localhost:3001");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // 'unsafe-inline' in script-src is deliberate: the App Router's inline
    // hydration flight scripts are blocked by a static 'self'-only policy.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');

    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    // camera=(self) enables the QR attendance scanner; microphone stays off.
    expect(headers.get('Permissions-Policy')).toContain('camera=(self)');
    expect(headers.get('Permissions-Policy')).toContain('microphone=()');
    expect(headers.get('Permissions-Policy')).toContain('geolocation=(self)');
  });

  it('keeps the service worker and manifest header rules', async () => {
    const rules = await nextConfig.headers!();
    const sw = rules.find((rule) => rule.source === '/sw.js');
    expect(sw?.headers.map((h) => h.key)).toContain('Service-Worker-Allowed');
    const manifest = rules.find((rule) => rule.source === '/manifest.webmanifest');
    expect(manifest).toBeTruthy();
  });
});
