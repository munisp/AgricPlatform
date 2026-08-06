import { createHmac, timingSafeEqual } from 'node:crypto';

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

/** Resolves the signing secret; fails closed when production lacks one. */
export function resolveVoucherSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENT_VOUCHER_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new Error(
      'AGENT_VOUCHER_SECRET is required in production — refusing to sign vouchers with the development default.'
    );
  }
  return DEV_VOUCHER_SECRET;
}
