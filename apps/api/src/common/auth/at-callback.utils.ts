import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { isProduction } from './auth.config.js';

/**
 * Africa's Talking callback authenticity gate (audit C2-3, Stage-24 A3-1).
 * AT does NOT sign its USSD/Voice callbacks, so the standard mitigations are
 * an unguessable shared secret plus an optional IP allowlist. This mirrors
 * the phase3 assertWebhookToken contract:
 *
 * - `AT_CALLBACK_TOKEN` configured → the callback must present it. PREFERRED
 *   TRANSPORT is the `x-at-callback-token` HEADER (query strings leak into
 *   access logs / browser history); the `token` query parameter (embedded in
 *   the AT dashboard callback URL) is accepted for AT compatibility and the
 *   request-log serializer strips query strings so it is never logged
 *   (common/logging/redaction.ts). Compared timing-safe, mismatch → 401.
 * - Not configured → open outside production (tests/dev posture) and refused
 *   in production; the channel services additionally refuse to BOOT in
 *   production when a live|sandbox driver lacks a STRONG token (fail closed):
 *   published placeholders ('replace-me', 'local-development-only'), empty
 *   values and tokens shorter than 32 characters are treated as missing
 *   (Stage-24 A3-1 — a copied .env.example must never authenticate
 *   production callbacks).
 * - `AT_CALLBACK_IP_ALLOWLIST` (comma-separated IPs) → when non-empty the
 *   caller IP must be listed, otherwise 403. Empty/unset disables the check.
 */

/** Published placeholder values that must never authenticate production traffic. */
export const AT_CALLBACK_TOKEN_PLACEHOLDERS = ['replace-me', 'local-development-only'] as const;

/** Minimum production token length (generate with `openssl rand -hex 32`). */
export const AT_CALLBACK_TOKEN_MIN_LENGTH = 32;

/**
 * True when the configured token is unusable in production: unset/empty, a
 * published placeholder, or below the strength floor. Outside production any
 * value is acceptable (dev/test posture).
 */
export function weakAtCallbackToken(token: string | undefined): boolean {
  if (!token || token.trim().length === 0) {
    return true;
  }
  if ((AT_CALLBACK_TOKEN_PLACEHOLDERS as readonly string[]).includes(token)) {
    return true;
  }
  return token.length < AT_CALLBACK_TOKEN_MIN_LENGTH;
}

/**
 * Env vars the channel boot guards require in production beyond AT
 * credentials. Only invoked on the production boot path, so a missing OR
 * weak/placeholder AT_CALLBACK_TOKEN is reported (fail closed, A3-1).
 */
export function missingAtCallbackConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return weakAtCallbackToken(env.AT_CALLBACK_TOKEN) ? ['AT_CALLBACK_TOKEN'] : [];
}

/**
 * Shared-secret gate for the AT USSD/IVR/agent-USSD callbacks. `provided` is
 * the `x-at-callback-token` header value (preferred) or the `token` query
 * param.
 */
export function assertAtCallbackToken(
  provided: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  isProd: boolean = isProduction(env)
): void {
  const expected = env.AT_CALLBACK_TOKEN;
  if (!expected) {
    if (isProd) {
      throw new UnauthorizedException(
        "Africa's Talking callback token is not configured; refusing unauthenticated production traffic"
      );
    }
    return;
  }
  if (isProd && weakAtCallbackToken(expected)) {
    // Defense in depth (A3-1): the boot guards refuse this configuration;
    // if traffic still arrives, never authenticate against a weak secret.
    throw new UnauthorizedException(
      "Africa's Talking callback token is a published placeholder or too weak for production; refusing callback traffic"
    );
  }
  const candidate = provided ?? '';
  const match =
    candidate.length === expected.length &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  if (!match) {
    throw new UnauthorizedException("Invalid Africa's Talking callback token");
  }
}

/** Parses AT_CALLBACK_IP_ALLOWLIST; empty/unset means the check is disabled. */
export function atCallbackIpAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AT_CALLBACK_IP_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => normaliseCallbackIp(entry.trim()))
    .filter((entry) => entry.length > 0);
}

/** Rejects callers outside the configured IP allowlist (when one is set). */
export function assertAtCallbackIp(
  ip: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  const allowlist = atCallbackIpAllowlist(env);
  if (allowlist.length === 0) {
    return;
  }
  const caller = normaliseCallbackIp(ip ?? '');
  if (!caller || !allowlist.includes(caller)) {
    throw new ForbiddenException(
      "Africa's Talking callback source IP is not on AT_CALLBACK_IP_ALLOWLIST"
    );
  }
}

/** Normalises IPv6-mapped IPv4 addresses so allowlist entries match either form. */
function normaliseCallbackIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}
