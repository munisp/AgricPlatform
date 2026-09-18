import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_HMAC_SECRET_MIN_LENGTH
} from '../../common/auth/auth.config.js';
import {
  hmacSign,
  hmacVerify,
  resolveHmacKeyRing,
  type HmacKeyRing
} from '../../common/crypto/key-rotation.js';

/**
 * Offline-voucher signature scheme (wave AGENTBANK). A voucher payload —
 * {voucherId, agentId, farmerId, amountKobo, expiry, nonce} — is signed with
 * HMAC-SHA256 keyed by a server-side secret (AGENT_VOUCHER_SECRET). The
 * canonical string is a versioned, dot-joined encoding of the payload fields
 * in a FIXED order so any tampering (amount raised, farmer swapped, expiry
 * extended) invalidates the signature. Verification runs SERVER-SIDE ONLY:
 * the secret never leaves the API, and comparison is constant-time.
 *
 * The development default secret is clearly labelled and must be overridden
 * in any real deployment (see docs/agent-banking.md).
 *
 * KEY ROTATION (V-26 — reference adoption of common/crypto/key-rotation):
 * new signatures carry the signing key id as `<kid>:<hmac-hex>`; the ring
 * accepts the ACTIVE plus PREVIOUS keys during the rotation window and
 * rejects retired kids outright. Bare-hex signatures (printed before kid
 * envelopes shipped) keep verifying against every ring secret during the
 * transition window — set AGENT_VOUCHER_KEYS="kid=secret,..." to rotate;
 * once every fielded voucher carries a kid, drop the legacy path.
 */

export const VOUCHER_PAYLOAD_VERSION = 'v1';

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_VOUCHER_SECRET = 'agent-banking-dev-voucher-secret-INSECURE';

export interface VoucherPayload {
  voucherId: string;
  agentId: string;
  farmerId: string;
  amountKobo: number;
  /** ISO-8601 expiry instant. */
  expiry: string;
  nonce: string;
}

/** Canonical, versioned encoding — field order is part of the contract. */
export function canonicalVoucherPayload(payload: VoucherPayload): string {
  return [
    VOUCHER_PAYLOAD_VERSION,
    payload.voucherId,
    payload.agentId,
    payload.farmerId,
    String(payload.amountKobo),
    payload.expiry,
    payload.nonce
  ].join('.');
}

/** HMAC-SHA256 hex signature over the canonical payload. */
export function signVoucher(payload: VoucherPayload, secret: string): string {
  return createHmac('sha256', secret).update(canonicalVoucherPayload(payload)).digest('hex');
}

/** Constant-time verification; returns false on any malformed input. */
export function verifyVoucherSignature(
  payload: VoucherPayload,
  signature: string,
  secret: string
): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  const expected = signVoucher(payload, secret);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Resolves the signing secret; fails closed when production lacks one.
 * Production additionally rejects the published development default
 * (zero entropy — it is committed in this repo) and enforces a length
 * floor (audit A3-2/A3-3).
 */
export function resolveVoucherSecret(env: NodeJS.ProcessEnv = process.env): string {
  assertProductionSecretStrength(env, 'AGENT_VOUCHER_SECRET', {
    minLength: PRODUCTION_HMAC_SECRET_MIN_LENGTH,
    publishedDefaults: [DEV_VOUCHER_SECRET]
  });
  const configured = env.AGENT_VOUCHER_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (isProduction(env)) {
    // Unreachable (the strength gate above throws first); kept as a
    // defense-in-depth guard for future refactors.
    throw new Error(
      'AGENT_VOUCHER_SECRET is required in production — refusing to sign vouchers with the development default.'
    );
  }
  return DEV_VOUCHER_SECRET;
}

/**
 * V-26: the voucher signing key RING. Preferred env: AGENT_VOUCHER_KEYS
 * ("kid=secret,kid=secret" — first pair active, rest verify-only previous).
 * AGENT_VOUCHER_SECRET remains as the legacy single-key fallback (kid
 * 'legacy'); the published dev default maps to kid 'dev'.
 */
export function resolveVoucherKeyRing(env: NodeJS.ProcessEnv = process.env): HmacKeyRing {
  return resolveHmacKeyRing(env, {
    keysEnv: 'AGENT_VOUCHER_KEYS',
    legacyEnv: 'AGENT_VOUCHER_SECRET',
    devDefault: DEV_VOUCHER_SECRET,
    fallbackKid: isProduction(env) ? 'legacy' : 'dev',
    purpose: 'agent-banking voucher signing',
    minLength: PRODUCTION_HMAC_SECRET_MIN_LENGTH,
    publishedDefaults: [DEV_VOUCHER_SECRET]
  });
}

/**
 * Signs a voucher payload with the ring's ACTIVE key — the returned
 * signature is the key-versioned envelope `<kid>:<hmac-hex>`.
 */
export function signVoucherEnvelope(payload: VoucherPayload, ring: HmacKeyRing): string {
  return hmacSign(ring, canonicalVoucherPayload(payload));
}

/**
 * Constant-time verification of a voucher signature against the ring:
 * accepts active+previous kids, rejects retired kids, and (transition
 * window) accepts bare-hex legacy signatures verified against every ring
 * secret.
 */
export function verifyVoucherEnvelope(
  payload: VoucherPayload,
  signature: string,
  ring: HmacKeyRing
): boolean {
  return hmacVerify(ring, canonicalVoucherPayload(payload), signature, { legacyBareHex: true }).ok;
}
