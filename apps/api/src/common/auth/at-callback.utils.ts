import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

/**
 * Africa's Talking callback authenticity gate (audit C2-3). AT does NOT sign
 * its USSD/Voice callbacks, so the standard mitigations are an unguessable
 * shared secret embedded in the configured callback URL plus an optional IP
 * allowlist. This mirrors the phase3 assertWebhookToken contract:
 *
 * - `AT_CALLBACK_TOKEN` configured → the callback must present it as the
 *   `token` query parameter (embed it in the AT dashboard callback URL) or
 *   the `x-at-callback-token` header; compared timing-safe, mismatch → 401.
 * - Not configured → open outside production (tests/dev posture) and refused
 *   in production; the channel services additionally refuse to BOOT in
 *   production when a live|sandbox driver lacks the token (fail closed).
 * - `AT_CALLBACK_IP_ALLOWLIST` (comma-separated IPs) → when non-empty the
 *   caller IP must be listed, otherwise 403. Empty/unset disables the check.
 */

/** Env vars the channel boot guards require in production beyond AT credentials. */
export function missingAtCallbackConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.AT_CALLBACK_TOKEN ? [] : ['AT_CALLBACK_TOKEN'];
}

/**
 * Shared-secret gate for the AT USSD/IVR/agent-USSD callbacks. `provided` is
 * the `token` query param or the `x-at-callback-token` header value.
 */
export function assertAtCallbackToken(
  provided: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  isProd: boolean = env.NODE_ENV === 'production'
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
