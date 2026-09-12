import { createHmac } from 'node:crypto';
import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_HMAC_SECRET_MIN_LENGTH
} from '../../common/auth/auth.config.js';

/**
 * MSISDN handling for the Voice Teller rail (Stage 27, Innovation 6),
 * Nigeria data-protection posture (NDPA 2023), mirroring the NIN doctrine
 * in input-vouchers/nin-crypto.ts: the caller's phone number is NEVER
 * persisted on intent-session audit rows. Only a salted HMAC-SHA256 hash
 * (dedupe/analytics key — an unkeyed hash would be trivially reversible
 * over the roughly 10^10 Nigerian MSISDN space) is stored. OTel span
 * attributes likewise never carry the MSISDN (hashed or plain).
 *
 * The salt comes from MSISDN_HASH_SALT; the development default is clearly
 * labelled and rejected in production, mirroring the NIN/agent-voucher
 * secret doctrine.
 */

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_MSISDN_HASH_SALT = 'voice-teller-dev-msisdn-salt-INSECURE';

export class InvalidMsisdnError extends Error {
  constructor() {
    super('MSISDN must be 7-15 digits (optional leading +)');
    this.name = 'InvalidMsisdnError';
  }
}

/**
 * Normalises to digits only (drops spaces, hyphens and the leading +) and
 * validates the E.164-ish length. Character comparisons instead of regex
 * escapes keep this source file free of literal backslashes.
 */
export function normalizeMsisdn(msisdn: string): string {
  const digits = msisdn
    .split('')
    .filter((ch) => ch >= '0' && ch <= '9')
    .join('');
  if (digits.length < 7 || digits.length > 15) {
    throw new InvalidMsisdnError();
  }
  return digits;
}

/** Salted HMAC-SHA256 hex over the normalised MSISDN — the only persisted form. */
export function hashMsisdn(msisdn: string, salt: string): string {
  return createHmac('sha256', salt).update(`msisdn:v1:${normalizeMsisdn(msisdn)}`).digest('hex');
}

/**
 * Resolves the hash salt; fails closed when production lacks one.
 * Production additionally rejects the published development default and
 * enforces a length floor — a short/known pepper leaves the MSISDN space
 * open to offline dictionary attack.
 */
export function resolveMsisdnHashSalt(env: NodeJS.ProcessEnv = process.env): string {
  assertProductionSecretStrength(env, 'MSISDN_HASH_SALT', {
    minLength: PRODUCTION_HMAC_SECRET_MIN_LENGTH,
    publishedDefaults: [DEV_MSISDN_HASH_SALT]
  });
  const configured = env.MSISDN_HASH_SALT?.trim();
  if (configured) {
    return configured;
  }
  if (isProduction(env)) {
    // Unreachable (the strength gate above throws first); defense in depth.
    throw new Error(
      'MSISDN_HASH_SALT is required in production — refusing to hash MSISDNs with the development default.'
    );
  }
  return DEV_MSISDN_HASH_SALT;
}
