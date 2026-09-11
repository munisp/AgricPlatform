/**
 * Partner API configuration (wave P5d).
 *
 * `PARTNER_API_DRIVER`:
 *   - `sandbox` (default outside production): tokens are signed with a
 *     development-only secret when PARTNER_API_SIGNING_SECRET is unset, and
 *     responses are flagged `sandbox: true`. FORBIDDEN in production —
 *     assertProductionPartnerApiConfig aborts the boot (fail closed).
 *   - `live`: requires a private PARTNER_API_SIGNING_SECRET (never the
 *     published development secret); production boots fail closed without it
 *     (assertProductionPartnerApiConfig, wired in main.ts).
 *
 * Rate limiting: each partner client gets a token bucket of
 * `rate_limit_per_min` requests per 60s window (default 1000). Burst policy:
 * the bucket starts full and refills continuously, so short bursts up to the
 * full minute's allowance are accepted, then throttled to the sustained rate.
 */

import { isProduction } from '../../common/auth/auth.config.js';

export interface PartnerApiConfig {
  driver: 'sandbox' | 'live';
  /** HMAC secret used to sign/verify partner access tokens (jose, HS256). */
  signingSecret: string;
  /** Access token TTL in seconds (short-lived). */
  tokenTtlSeconds: number;
  /** True when running against the sandbox driver. */
  sandbox: boolean;
}

/** Development-only fallback secret. Never acceptable when the driver is live. */
export const PARTNER_API_DEV_SECRET = 'partner-api-dev-only-signing-secret';

export function loadPartnerApiConfig(env: NodeJS.ProcessEnv = process.env): PartnerApiConfig {
  const driver = env.PARTNER_API_DRIVER === 'live' ? 'live' : 'sandbox';
  const configured = env.PARTNER_API_SIGNING_SECRET;
  const signingSecret = configured ?? (driver === 'live' ? '' : PARTNER_API_DEV_SECRET);
  return {
    driver,
    signingSecret,
    tokenTtlSeconds: Number(env.PARTNER_API_TOKEN_TTL_SECONDS ?? 900),
    sandbox: driver !== 'live'
  };
}

/**
 * Fail-closed boot check: a live partner API without a signing secret would
 * silently sign tokens with the published development secret. Refuse to
 * start instead (mirrors assertProductionDriverConfig in integrations).
 */
export function assertProductionPartnerApiConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) {
    return;
  }
  // Fail closed: the sandbox driver signs partner tokens with the PUBLISHED
  // development secret (PARTNER_API_DEV_SECRET) when none is configured —
  // silently accepting it in production would let anyone mint valid partner
  // tokens. Production requires the live driver, full stop.
  if (env.PARTNER_API_DRIVER !== 'live') {
    throw new Error(
      'FATAL: NODE_ENV=production requires PARTNER_API_DRIVER=live. The sandbox driver ' +
        'signs partner access tokens with the published development secret and is forbidden ' +
        'in production. Refusing to start.'
    );
  }
  if (
    !env.PARTNER_API_SIGNING_SECRET ||
    env.PARTNER_API_SIGNING_SECRET === PARTNER_API_DEV_SECRET
  ) {
    throw new Error(
      'FATAL: PARTNER_API_DRIVER=live requires PARTNER_API_SIGNING_SECRET so partner ' +
        'access tokens are signed with a private key (not the published development ' +
        'secret). Refusing to start.'
    );
  }
}
