import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { isProduction } from './auth.config.js';

/**
 * Africa's Talking callback authenticity gate (audit C2-3, Stage-24 A3-1).
 * AT does NOT sign its USSD/Voice callbacks, so the standard mitigations are
 * an unguessable shared secret plus an optional IP allowlist. This mirrors
 * the phase3 assertWebhookToken contract:
 *
 * - `AT_CALLBACK_TOKEN` configured → the callback must present it. The ONLY
 *   accepted transport in production is the `x-at-callback-token` HEADER
 *   (V-19): query strings leak into CDN/proxy/edge logs outside the app's
 *   redaction control, so a `?token=` credential is refused there. Outside
 *   production the `token` query parameter (embedded in the AT dashboard
 *   callback URL) is still accepted for AT compatibility, and the request-log
 *   serializer strips query strings so it is never logged
 *   (common/logging/redaction.ts). Compared timing-safe, mismatch → 401.
 * - Production callbacks additionally require a per-request timestamp/nonce
 *   pair (assertAtCallbackFreshness, V-19): a captured callback replayed
 *   verbatim fails even with a valid token.
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

/**
 * Resolves the presented callback token (V-19). Production is header-only:
 * a `?token=` query credential is refused outright because query strings
 * leak into CDN/proxy/edge logs outside the app's redaction control (the
 * app strips them only in its OWN logs). Outside production the legacy
 * query-param fallback stays for AT-dashboard compatibility in dev/test.
 */
export function resolveAtCallbackToken(
  queryToken: string | undefined,
  headerToken: string | undefined,
  isProd: boolean = isProduction()
): string | undefined {
  if (isProd) {
    if (queryToken !== undefined) {
      throw new UnauthorizedException(
        'Refusing query-string callback token in production; present the x-at-callback-token header'
      );
    }
    return headerToken;
  }
  return queryToken ?? headerToken;
}

/** Maximum accepted age/skew for the per-request callback timestamp (V-19). */
export const AT_CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * In-process replay cache for callback nonces (V-19). A nonce is claimable
 * exactly once per TTL window; TTL matches the accepted timestamp skew so a
 * nonce cannot be burned far ahead of its timestamp and replayed later.
 * Per replica — cross-instance replays remain backstopped by the session
 * state checks in the channel services.
 */
export class AtCallbackNonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number = AT_CALLBACK_MAX_SKEW_MS * 2) {}

  /** True the first time a nonce is presented inside its TTL; false on replay. */
  claim(nonce: string, now: number = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(nonce)) {
      return false;
    }
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(nonce);
      }
    }
  }
}

/** Shared process-wide nonce cache for the channel controllers. */
export const atCallbackNonceCache = new AtCallbackNonceCache();

/**
 * Per-request freshness gate (V-19), production profile only — non-prod
 * behavior is unchanged. Production callbacks must carry:
 * - `x-at-callback-timestamp`: epoch milliseconds within ±AT_CALLBACK_MAX_SKEW_MS;
 * - `x-at-callback-nonce`: 8-128 chars, never seen inside the replay window.
 * A captured callback replayed verbatim therefore 401s even with a valid
 * shared token. (True provider authenticity needs signed webhooks — tracked
 * as external gate E-06; this is the ceiling until AT offers them.)
 */
export function assertAtCallbackFreshness(
  input: { timestamp?: string; nonce?: string },
  cache: AtCallbackNonceCache = atCallbackNonceCache,
  isProd: boolean = isProduction(),
  now: number = Date.now()
): void {
  if (!isProd) {
    return;
  }
  const timestamp = Number(input.timestamp);
  if (
    !input.timestamp ||
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > AT_CALLBACK_MAX_SKEW_MS
  ) {
    throw new UnauthorizedException(
      "Africa's Talking callback timestamp header is missing, malformed or outside the accepted window"
    );
  }
  const nonce = input.nonce ?? '';
  if (nonce.length < 8 || nonce.length > 128 || !cache.claim(nonce, now)) {
    throw new UnauthorizedException(
      "Africa's Talking callback nonce is missing, malformed or already seen (replay refused)"
    );
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
