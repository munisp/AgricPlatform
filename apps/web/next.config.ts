import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * Origin of the NestJS API for CSP connect-src. Derived from the public env
 * var (falls back to the local dev API) so the policy matches the client.
 */
const apiOrigin = (() => {
  try {
    return new URL(
      process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1'
    ).origin;
  } catch {
    return 'http://localhost:3001';
  }
})();

/**
 * Baseline Content Security Policy.
 * - 'self' everywhere by default; the API origin is the only extra connect-src.
 * - script-src allows 'unsafe-inline' because the App Router embeds its
 *   hydration/flight payload in inline scripts (`self.__next_f.push(...)`);
 *   a static 'self'-only policy silently blocks hydration of any route with
 *   a suspense boundary (the page never leaves its loading.tsx fallback).
 *   Upgrade path: per-request nonce CSP via middleware + 'strict-dynamic'.
 * - style-src allows 'unsafe-inline' because the app uses style attributes.
 * - NO 'unsafe-eval' anywhere.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // camera=(self) is required by the chapter QR attendance scanner
  // (getUserMedia); it degrades to the paste-in flow when denied.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' }
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the Turbopack workspace root to the monorepo root. In the Docker
  // partial-workspace install (and any non-standard node_modules layout)
  // Next cannot infer the root and refuses to build.
  turbopack: { root: resolve(configDir, '../..') },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' }
        ]
      },
      {
        source: '/manifest.webmanifest',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600' }]
      },
      {
        // Non-hashed icon filenames (manifest icons) — cacheable for a day,
        // never immutable.
        source: '/icon-:size(\\d+).png',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }]
      },
      {
        source: '/:path*',
        headers: securityHeaders
      }
    ];
  }
};

export default nextConfig;
