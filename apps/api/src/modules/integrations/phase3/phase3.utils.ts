import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_SHARED_SECRET_MIN_LENGTH
} from '../../../common/auth/auth.config.js';

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

/** Minimum acceptable length for a configured production webhook token. */
export const PHASE3_WEBHOOK_TOKEN_MIN_LENGTH = PRODUCTION_SHARED_SECRET_MIN_LENGTH;

/**
 * Fail-closed boot check (audit A3-5): the federated webhook tokens are
 * the ONLY authenticity check on the push receivers, and the endpoints are
 * rate-limited rather than lockout-limited — a 1–2 char token falls to
 * online guessing in minutes. An UNSET token stays legal here because
 * assertWebhookToken already refuses production traffic per request; a SET
 * token must meet the strength floor. Wired in main.ts.
 */
export function assertProductionPhase3WebhookTokens(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isProduction(env)) {
    return;
  }
  for (const system of ['FARMOS', 'LITEFARM', 'OFN', 'LENDER'] as const) {
    assertProductionSecretStrength(env, `${system}_WEBHOOK_TOKEN`, {
      minLength: PHASE3_WEBHOOK_TOKEN_MIN_LENGTH,
      required: false
    });
  }
}
