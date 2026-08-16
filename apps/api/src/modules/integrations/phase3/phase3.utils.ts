import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { isProduction } from '../../../common/auth/auth.config.js';

/** SHA-256 hex digest used for identity minimisation (NIN/phone/member refs). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Normalises a phone number before hashing: digits only. */
export function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Normalises a NIN before hashing: strip whitespace, uppercase. */
export function normaliseNin(nin: string): string {
  return nin.replace(/\s+/g, '').toUpperCase();
}

/** Stable dedupe key for inbound events without a provider event id. */
export function payloadDedupeKey(payload: unknown): string {
  return sha256(JSON.stringify(payload) ?? '');
}

/**
 * Shared-secret webhook gate for the federated systems. When the system's
 * `<SYSTEM>_WEBHOOK_TOKEN` env var is configured the `x-integration-token`
 * header must match (timing-safe). When it is not configured the endpoint
 * is open outside production (stub posture) and refuses production traffic
 * — fail closed, mirroring the provider webhook contract.
 */
export function assertWebhookToken(
  system: 'farmos' | 'litefarm' | 'ofn' | 'lender',
  tokenHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  isProd: boolean = isProduction(env)
): void {
  const expected = env[`${system.toUpperCase()}_WEBHOOK_TOKEN`];
  if (!expected) {
    if (isProd) {
      throw new UnauthorizedException(
        `Webhook token for '${system}' is not configured; refusing unauthenticated production traffic`
      );
    }
    return;
  }
  const provided = tokenHeader ?? '';
  const match =
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!match) {
    throw new UnauthorizedException(`Invalid webhook token for '${system}'`);
  }
}
