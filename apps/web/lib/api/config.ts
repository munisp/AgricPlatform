/**
 * API client configuration. The base URL is env-driven so the same build can
 * point at a local NestJS dev server, staging or production without code
 * changes. Defaults to the local API (`apps/api`, see README).
 */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1'
).replace(/\/$/, '');

/** Default request timeout — generous enough for low-bandwidth mobile links. */
export const DEFAULT_TIMEOUT_MS = 10_000;
