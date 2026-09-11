import { createHmac, timingSafeEqual } from 'node:crypto';
import { isProduction } from '../../common/auth/auth.config.js';

/**
 * e-WHR signature scheme (wave WAREHOUSE), mirroring the agent-banking
 * offline-voucher scheme. A receipt payload — {receiptNumber, depositId,
 * warehouseId, ownerId, crop, grade, bagCount, weightKg, issuedAt, nonce} —
 * is signed with HMAC-SHA256 keyed by a server-side secret
 * (WAREHOUSE_RECEIPT_SECRET). The canonical string is a versioned,
 * dot-joined encoding of the payload fields in a FIXED order so any
 * tampering (weight raised, owner swapped, grade changed) invalidates the
 * signature. Verification runs SERVER-SIDE ONLY: the secret never leaves
 * the API, and comparison is constant-time.
 *
 * The development default secret is clearly labelled and must be overridden
 * in any real deployment (see docs/warehouse-receipts.md).
 */

export const RECEIPT_PAYLOAD_VERSION = 'v1';

/** Clearly-labelled development default — never acceptable in production. */
export const DEV_RECEIPT_SECRET = 'warehouse-dev-receipt-secret-INSECURE';

export interface ReceiptPayload {
  receiptNumber: string;
  depositId: string;
  warehouseId: string;
  ownerId: string;
  crop: string;
  grade: string;
  bagCount: number;
  weightKg: number;
  issuedAt: string;
  nonce: string;
}

/** Canonical, versioned encoding — field order is part of the contract. */
export function canonicalReceiptPayload(payload: ReceiptPayload): string {
  return [
    RECEIPT_PAYLOAD_VERSION,
    payload.receiptNumber,
    payload.depositId,
    payload.warehouseId,
    payload.ownerId,
    payload.crop,
    payload.grade,
    String(payload.bagCount),
    String(payload.weightKg),
    payload.issuedAt,
    payload.nonce
  ].join('.');
}

/** HMAC-SHA256 hex signature over the canonical payload. */
export function signReceipt(payload: ReceiptPayload, secret: string): string {
  return createHmac('sha256', secret).update(canonicalReceiptPayload(payload)).digest('hex');
}

/** Constant-time verification; returns false on any malformed input. */
export function verifyReceiptSignature(
  payload: ReceiptPayload,
  signature: string,
  secret: string
): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  const expected = signReceipt(payload, secret);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/** Resolves the signing secret; fails closed when production lacks one. */
export function resolveReceiptSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WAREHOUSE_RECEIPT_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (isProduction(env)) {
    throw new Error(
      'WAREHOUSE_RECEIPT_SECRET is required in production — refusing to sign receipts with the development default.'
    );
  }
  return DEV_RECEIPT_SECRET;
}
