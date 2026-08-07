import { describe, expect, it } from 'vitest';
import {
  canonicalReceiptPayload,
  DEV_RECEIPT_SECRET,
  RECEIPT_PAYLOAD_VERSION,
  resolveReceiptSecret,
  signReceipt,
  verifyReceiptSignature,
  type ReceiptPayload
} from './receipt-crypto.js';

const payload: ReceiptPayload = {
  receiptNumber: 'WHR-2026-3F9A1C2E',
  depositId: 'whdeposit-1',
  warehouseId: 'warehouse-1',
  ownerId: 'user-farmer',
  crop: 'maize',
  grade: 'A',
  bagCount: 40,
  weightKg: 2000,
  issuedAt: '2026-02-01T00:00:00.000Z',
  nonce: 'nonce-1'
};

describe('receipt-crypto', () => {
  it('canonical payload is versioned and dot-joined in a fixed order', () => {
    expect(canonicalReceiptPayload(payload)).toBe(
      [
        RECEIPT_PAYLOAD_VERSION,
        'WHR-2026-3F9A1C2E',
        'whdeposit-1',
        'warehouse-1',
        'user-farmer',
        'maize',
        'A',
        '40',
        '2000',
        '2026-02-01T00:00:00.000Z',
        'nonce-1'
      ].join('.')
    );
  });

  it('signing is deterministic for the same payload and secret', () => {
    expect(signReceipt(payload, 's')).toBe(signReceipt(payload, 's'));
    expect(signReceipt(payload, 's')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a valid signature', () => {
    const signature = signReceipt(payload, DEV_RECEIPT_SECRET);
    expect(verifyReceiptSignature(payload, signature, DEV_RECEIPT_SECRET)).toBe(true);
  });

  it('rejects a tampered weight', () => {
    const signature = signReceipt(payload, DEV_RECEIPT_SECRET);
    expect(verifyReceiptSignature({ ...payload, weightKg: 4000 }, signature, DEV_RECEIPT_SECRET)).toBe(
      false
    );
  });

  it('rejects a swapped owner', () => {
    const signature = signReceipt(payload, DEV_RECEIPT_SECRET);
    expect(
      verifyReceiptSignature({ ...payload, ownerId: 'user-attacker' }, signature, DEV_RECEIPT_SECRET)
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const signature = signReceipt(payload, 'other-secret');
    expect(verifyReceiptSignature(payload, signature, DEV_RECEIPT_SECRET)).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifyReceiptSignature(payload, 'not-hex', DEV_RECEIPT_SECRET)).toBe(false);
    expect(verifyReceiptSignature(payload, 'a'.repeat(63), DEV_RECEIPT_SECRET)).toBe(false);
    expect(verifyReceiptSignature(payload, 'g'.repeat(64), DEV_RECEIPT_SECRET)).toBe(false);
  });

  it('resolveReceiptSecret prefers the configured secret', () => {
    expect(resolveReceiptSecret({ WAREHOUSE_RECEIPT_SECRET: 'prod-secret' })).toBe('prod-secret');
  });

  it('resolveReceiptSecret falls back to the labelled dev secret outside production', () => {
    expect(resolveReceiptSecret({ NODE_ENV: 'development' })).toBe(DEV_RECEIPT_SECRET);
    expect(DEV_RECEIPT_SECRET).toContain('INSECURE');
  });

  it('resolveReceiptSecret fails closed in production without a secret', () => {
    expect(() => resolveReceiptSecret({ NODE_ENV: 'production' })).toThrow(
      /WAREHOUSE_RECEIPT_SECRET/
    );
  });
});
