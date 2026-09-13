import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  assertProductionSecretStrength,
  isProduction,
  PRODUCTION_HMAC_SECRET_MIN_LENGTH
} from '../../common/auth/auth.config.js';

/**
 * Dealer QR payload signature scheme (Stage 27, Innovation 16) — the
 * voucher-crypto pattern applied to merchant QR/intent codes. A QR payload
 * — {qrId, agentOrgId, dealerUserId, label, issuedAt} — is signed with
 * HMAC-SHA256 keyed by a server-side secret (AGENT_QR_SECRET). The
 * canonical string is a versioned, dot-joined encoding of the payload
 * fields in a FIXED order so any tampering (dealer swapped, label
 * rewritten, code rebound to another agent organisation) invalidates the
 * signature. Verification runs SERVER-SIDE ONLY: the secret never leaves
 * the API, and comparison is constant-time.
 *
 * The label is part of the signed payload, so it must never contain the
 * '.' separator (enforced at issuance) — that keeps the canonical encoding
 * unambiguous.
 *
 * The development default secret is clearly labelled and must be overridden
 * in any real deployment; production additionally rejects it (same
 * strength gate as AGENT_VOUCHER_SECRET).
 */

export const QR_PAYLOAD_VERSION = 'v1';

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_QR_SECRET = 'agent-banking-dev-qr-secret-INSECURE';

export interface QrPayload {
  qrId: string;
  /** Agent organisation id (agent_banking.agents row) the code belongs to. */
  agentOrgId: string;
  /** Dealer's user id (owner of the agent record). */
  dealerUserId: string;
  label: string;
  /** ISO-8601 issuance instant (the row's created_at). */
  issuedAt: string;
}

/** Canonical, versioned encoding — field order is part of the contract. */
export function canonicalQrPayload(payload: QrPayload): string {
  return [
    QR_PAYLOAD_VERSION,
    payload.qrId,
    payload.agentOrgId,
    payload.dealerUserId,
    payload.label,
    payload.issuedAt
  ].join('.');
}

/** HMAC-SHA256 hex signature over the canonical payload. */
export function signQrPayload(payload: QrPayload, secret: string): string {
  return createHmac('sha256', secret).update(canonicalQrPayload(payload)).digest('hex');
}

/** Constant-time verification; returns false on any malformed input. */
export function verifyQrSignature(payload: QrPayload, signature: string, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  const expected = signQrPayload(payload, secret);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Privacy-preserving payer alias fingerprint (HMAC-SHA256 hex). The payer's
 * wallet alias/MSISDN is never persisted in plaintext on the payment row —
 * same doctrine as the NIN hash in input-vouchers.
 */
export function hashPayerAlias(payerAlias: string, secret: string): string {
  return createHmac('sha256', secret).update(`payer-alias.${payerAlias}`).digest('hex');
}

/**
 * Resolves the QR signing secret; fails closed when production lacks one.
 * Production rejects the published development default (zero entropy — it
 * is committed in this repo) and enforces a length floor, mirroring
 * resolveVoucherSecret (audit A3-2/A3-3).
 */
export function resolveQrSecret(env: NodeJS.ProcessEnv = process.env): string {
  assertProductionSecretStrength(env, 'AGENT_QR_SECRET', {
    minLength: PRODUCTION_HMAC_SECRET_MIN_LENGTH,
    publishedDefaults: [DEV_QR_SECRET]
  });
  const configured = env.AGENT_QR_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (isProduction(env)) {
    // Unreachable (the strength gate above throws first); kept as a
    // defense-in-depth guard for future refactors.
    throw new Error(
      'AGENT_QR_SECRET is required in production — refusing to sign QR codes with the development default.'
    );
  }
  return DEV_QR_SECRET;
}
