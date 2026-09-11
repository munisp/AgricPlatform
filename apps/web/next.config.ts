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
 * Basemap tile origin for the /map geoportal (NEXT_PUBLIC_MAP_TILES, OSM by
 * default). Parsed leniently: an invalid/relative template simply adds no
 * extra origin (the map then fails closed with its own error panel).
 */
const mapTileOrigin = (() => {
  try {
    return new URL(
      process.env.NEXT_PUBLIC_MAP_TILES ??
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    ).origin;
  } catch {
    return null;
  }
})();

/**
 * DuckDB-WASM asset origin for the geoportal's on-demand spatial queries
 * (NEXT_PUBLIC_DUCKDB_CDN; jsDelivr default, matching duckdb-wasm's own
 * bundle URLs). Only reached when a user runs a spatial query — the engine
 * is never in the page bundle.
 */
const duckdbCdnOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_DUCKDB_CDN ?? 'https://cdn.jsdelivr.net').origin;
  } catch {
    return 'https://cdn.jsdelivr.net';
  }
})();

/**
 * Baseline Content Security Policy.
 * - 'self' everywhere by default; the API origin is the only extra connect-src
 *   (plus the two geoportal origins below).
 * - script-src allows 'unsafe-inline' because the App Router embeds its
 *   hydration/flight payload in inline scripts (`self.__next_f.push(...)`);
 *   a static 'self'-only policy silently blocks hydration of any route with
 *   a suspense boundary (the page never leaves its loading.tsx fallback).
 *   Upgrade path: per-request nonce CSP via middleware + 'strict-dynamic'.
 * - style-src allows 'unsafe-inline' because the app uses style attributes.
 * - img-src gains the basemap tile origin (+ blob: for MapLibre's decoded
 *   tile bitmaps) — tiles are the only remote images.
 * - worker-src gains blob: for MapLibre's bundled worker and the geoportal's
 *   DuckDB-WASM worker (fetched as text from the CDN, then instantiated from
 *   a same-origin blob — no cross-origin Worker constructor, no script-src
 *   relaxation).
 * - connect-src gains the tile origin and the DuckDB asset origin.
 * - NO 'unsafe-eval' anywhere.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${mapTileOrigin ? ` ${mapTileOrigin}` : ''}`,
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin}${mapTileOrigin ? ` ${mapTileOrigin}` : ''} ${duckdbCdnOrigin}`,
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // HSTS: also set here as a defence-in-depth fallback. When the app sits
  // behind a CDN/edge terminator, the CDN may own (and override) this header.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
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
