import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_HMAC_SECRET_MIN_LENGTH
} from '../../common/auth/auth.config.js';

/**
 * Public credit-passport verification code (Stage 27, Innovation 7).
 * Mirrors the livestock-passport scheme (which itself mirrors the
 * agent-banking offline-voucher scheme): the code payload
 * {credentialId, userId, nonce} is HMAC-SHA256 signed with a server-side
 * secret (CREDIT_PASSPORT_SECRET) over a versioned, fixed-order canonical
 * string, so any tampering invalidates the signature. Verification runs
 * SERVER-SIDE ONLY: the secret never leaves the API, comparison is
 * constant-time, and forged codes fail verification.
 *
 * Wire format: `CRP.{credentialId}.{nonce}.{sig16}` — credential ids contain
 * hyphens (crp-<uuid>) so dots are the segment separators; sig16 is the
 * first 16 hex chars of the full signature (the code stays QR-friendly
 * while the full 64-char signature is stored and re-verified server-side).
 *
 * Parsing is regex-free (backslash-free source policy): segments are split
 * on dots and validated character-by-character.
 */

export const CREDIT_PASSPORT_CODE_VERSION = 'v1';

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_CREDIT_PASSPORT_CODE_SECRET = 'credit-passport-dev-code-secret-INSECURE';

export interface CreditPassportCodePayload {
  credentialId: string;
  userId: string;
  nonce: string;
}

/** Canonical, versioned encoding — field order is part of the contract. */
export function canonicalCodePayload(payload: CreditPassportCodePayload): string {
  return [
    CREDIT_PASSPORT_CODE_VERSION,
    payload.credentialId,
    payload.userId,
    payload.nonce
  ].join('.');
}

/** HMAC-SHA256 hex signature over the canonical payload. */
export function signPassportCode(payload: CreditPassportCodePayload, secret: string): string {
  return createHmac('sha256', secret).update(canonicalCodePayload(payload)).digest('hex');
}

/** Public code for QR payloads and the /verify route. */
export function formatPassportCode(
  credentialId: string,
  nonce: string,
  signature: string
): string {
  return ['CRP', credentialId, nonce, signature.slice(0, 16)].join('.');
}

export interface ParsedPassportCode {
  credentialId: string;
  nonce: string;
  /** First 16 hex chars of the claimed signature. */
  signaturePrefix: string;
}

/** True when every character of `value` is a lowercase hex digit. */
function isLowerHex(value: string, length: number): boolean {
  if (value.length !== length) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAf = code >= 97 && code <= 102;
    if (!isDigit && !isLowerAf) {
      return false;
    }
  }
  return true;
}

/** Parses the wire format; returns undefined on any malformed input. */
export function parsePassportCode(code: string): ParsedPassportCode | undefined {
  const segments = code.trim().split('.');
  if (segments.length !== 4 || segments[0] !== 'CRP') {
    return undefined;
  }
  const [, credentialId, nonce, signaturePrefix] = segments;
  if (!credentialId || !isLowerHex(nonce, 8) || !isLowerHex(signaturePrefix, 16)) {
    return undefined;
  }
  return { credentialId, nonce, signaturePrefix };
}

/**
 * Full verification: the claimed code prefix must match the stored full
 * signature, and the stored signature must itself be the HMAC of the
 * credential's payload — so a forged code (or a code replayed against a
 * tampered credential row) fails. Constant-time; false on malformed input.
 */
export function verifyPassportCode(
  payload: CreditPassportCodePayload,
  claimedSignaturePrefix: string,
  storedSignature: string,
  secret: string
): boolean {
  if (!isLowerHex(claimedSignaturePrefix, 16) || !isLowerHex(storedSignature, 64)) {
    return false;
  }
  if (!storedSignature.startsWith(claimedSignaturePrefix)) {
    return false;
  }
  const expected = signPassportCode(payload, secret);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(storedSignature, 'hex'));
}

/**
 * Resolves the signing secret; fails closed when production lacks one.
 * Production additionally rejects the published development default (it is
 * committed in this repo) and enforces a length floor.
 */
export function resolveCodeSecret(env: NodeJS.ProcessEnv = process.env): string {
  assertProductionSecretStrength(env, 'CREDIT_PASSPORT_SECRET', {
    minLength: PRODUCTION_HMAC_SECRET_MIN_LENGTH,
    publishedDefaults: [DEV_CREDIT_PASSPORT_CODE_SECRET]
  });
  const configured = env.CREDIT_PASSPORT_SECRET?.trim();
  if (configured && configured.length >= 16) {
    return configured;
  }
  if (isProduction(env)) {
    throw new Error(
      'CREDIT_PASSPORT_SECRET (>= 16 chars) is required in production — refusing to sign credit passport codes with the development default.'
    );
  }
  return DEV_CREDIT_PASSPORT_CODE_SECRET;
}
