import type { NextConfig } from 'next';

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
 * - style-src allows 'unsafe-inline' because the app uses style attributes.
 * - NO 'unsafe-eval' anywhere.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
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
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' }
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
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
        source: '/:path*',
        headers: securityHeaders
      }
    ];
  }
};

export default nextConfig;
