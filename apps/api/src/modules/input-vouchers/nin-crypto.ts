import { createHmac } from 'node:crypto';
import { isProduction } from '../../common/auth/auth.config.js';

/**
 * NIN handling for the input-subsidy voucher rail (wave NINVOUCHER),
 * Nigeria data-protection posture (NDPA 2023): the full National
 * Identification Number is NEVER persisted. Only a salted HMAC-SHA256 hash
 * (dedupe key, unkeyed hashes would be trivially reversible over the 11-digit
 * NIN space) and a last-3 mask (operator display) are stored.
 *
 * The salt comes from NIN_HASH_SALT; the development default is clearly
 * labelled and rejected in production, mirroring the agent-banking voucher
 * secret doctrine.
 */

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_NIN_HASH_SALT = 'input-vouchers-dev-nin-salt-INSECURE';

export class InvalidNinError extends Error {
  constructor() {
    super('NIN must be exactly 11 digits');
    this.name = 'InvalidNinError';
  }
}

/** Strips spaces/hyphens and validates the 11-digit NIN format. */
export function normalizeNin(nin: string): string {
  const normalized = nin.replace(/[\s-]+/g, '');
  if (!/^\d{11}$/.test(normalized)) {
    throw new InvalidNinError();
  }
  return normalized;
}

/** Salted HMAC-SHA256 hex over the normalised NIN — the only persisted form. */
export function hashNin(nin: string, salt: string): string {
  return createHmac('sha256', salt).update(`nin:v1:${normalizeNin(nin)}`).digest('hex');
}

/** Last-3 mask for operator display (e.g. '********123'). */
export function maskNin(nin: string): string {
  const normalized = normalizeNin(nin);
  return `${'*'.repeat(normalized.length - 3)}${normalized.slice(-3)}`;
}

/** Resolves the hash salt; fails closed when production lacks one. */
export function resolveNinHashSalt(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NIN_HASH_SALT?.trim();
  if (configured) {
    return configured;
  }
  if (isProduction(env)) {
    throw new Error(
      'NIN_HASH_SALT is required in production — refusing to hash NINs with the development default.'
    );
  }
  return DEV_NIN_HASH_SALT;
}
