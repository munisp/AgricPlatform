import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Public passport verification code (wave-livestock-passport). Mirrors the
 * agent-banking offline-voucher scheme (voucher-crypto.ts): the code payload
 * {passportId, animalId, nonce} is HMAC-SHA256 signed with a server-side
 * secret (LIVESTOCK_PASSPORT_SECRET) over a versioned, fixed-order canonical
 * string, so any tampering (animal swapped, nonce replayed onto another
 * passport) invalidates the signature. Verification runs SERVER-SIDE ONLY:
 * the secret never leaves the API, comparison is constant-time, and forged
 * codes fail verification.
 *
 * Wire format: `LSP.{animalId}.{nonce}.{sig16}` — animalId contains hyphens
 * (NG-BOV-KD-000123) so dots are the segment separators; sig16 is the first
 * 16 hex chars of the full signature (the code stays QR-friendly while the
 * full 64-char signature is stored and re-verified server-side).
 *
 * The development default secret is clearly labelled and must be overridden
 * in any real deployment (see docs/livestock-passport.md).
 */

export const PASSPORT_CODE_VERSION = 'v1';

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_PASSPORT_CODE_SECRET = 'livestock-passport-dev-code-secret-INSECURE';

export interface PassportCodePayload {
  passportId: string;
  animalId: string;
  nonce: string;
}

/** Canonical, versioned encoding — field order is part of the contract. */
export function canonicalPassportCodePayload(payload: PassportCodePayload): string {
  return [PASSPORT_CODE_VERSION, payload.passportId, payload.animalId, payload.nonce].join('.');
}

/** HMAC-SHA256 hex signature over the canonical payload. */
export function signPassportCode(payload: PassportCodePayload, secret: string): string {
  return createHmac('sha256', secret).update(canonicalPassportCodePayload(payload)).digest('hex');
}

/** Public code for QR payloads and the /verify route. */
export function formatPassportCode(animalId: string, nonce: string, signature: string): string {
  return `LSP.${animalId}.${nonce}.${signature.slice(0, 16)}`;
}

const CODE_PATTERN = /^LSP\.(.+)\.([0-9a-f]{8})\.([0-9a-f]{16})$/;

export interface ParsedPassportCode {
  animalId: string;
  nonce: string;
  /** First 16 hex chars of the claimed signature. */
  signaturePrefix: string;
}

/** Parses the wire format; returns undefined on any malformed input. */
export function parsePassportCode(code: string): ParsedPassportCode | undefined {
  const match = CODE_PATTERN.exec(code.trim());
  if (!match) {
    return undefined;
  }
  return { animalId: match[1], nonce: match[2], signaturePrefix: match[3] };
}

/**
 * Full verification: the claimed code prefix must match the stored full
 * signature, and the stored signature must itself be the HMAC of the
 * passport's payload — so a forged code (or a code replayed against a
 * tampered passport row) fails. Constant-time; false on malformed input.
 */
export function verifyPassportCode(
  payload: PassportCodePayload,
  claimedSignaturePrefix: string,
  storedSignature: string,
  secret: string
): boolean {
  if (!/^[0-9a-f]{16}$/.test(claimedSignaturePrefix) || !/^[0-9a-f]{64}$/.test(storedSignature)) {
    return false;
  }
  if (!storedSignature.startsWith(claimedSignaturePrefix)) {
    return false;
  }
  const expected = signPassportCode(payload, secret);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(storedSignature, 'hex'));
}

/** Resolves the signing secret; fails closed when production lacks one. */
export function resolvePassportCodeSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LIVESTOCK_PASSPORT_SECRET?.trim();
  if (configured && configured.length >= 16) {
    return configured;
  }
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new Error(
      'LIVESTOCK_PASSPORT_SECRET (>= 16 chars) is required in production — refusing to sign livestock passport codes with the development default.'
    );
  }
  return DEV_PASSPORT_CODE_SECRET;
}
