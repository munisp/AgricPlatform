import { describe, expect, it } from 'vitest';
import {
  DEV_VOUCHER_SECRET,
  canonicalVoucherPayload,
  resolveVoucherSecret,
  signVoucher,
  verifyVoucherSignature,
  type VoucherPayload
} from './voucher-crypto.js';

const PAYLOAD: VoucherPayload = {
  voucherId: 'voucher-test-1',
  agentId: 'agent-1',
  farmerId: 'farmer-1',
  amountKobo: 500_000,
  expiry: '2026-02-01T00:00:00.000Z',
  nonce: 'nonce-123'
};

/** Known-answer vector (computed once with node:crypto, then frozen). */
const KNOWN_ANSWER = 'fe87e7e5983c6a7bded159e6979031253ac747c7895dcc883f41973c01f2ad1b';

describe('voucher-crypto', () => {
  it('canonical encoding is versioned and field-ordered', () => {
    expect(canonicalVoucherPayload(PAYLOAD)).toBe(
      'v1.voucher-test-1.agent-1.farmer-1.500000.2026-02-01T00:00:00.000Z.nonce-123'
    );
  });

  it('signs to the known-answer HMAC-SHA256 vector', () => {
    expect(signVoucher(PAYLOAD, 'test-secret')).toBe(KNOWN_ANSWER);
  });

  it('verifies a valid signature', () => {
    expect(verifyVoucherSignature(PAYLOAD, KNOWN_ANSWER, 'test-secret')).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyVoucherSignature(PAYLOAD, KNOWN_ANSWER, 'other-secret')).toBe(false);
  });

  it('rejects tampering with the amount', () => {
    const tampered = { ...PAYLOAD, amountKobo: 5_000_000 };
    expect(verifyVoucherSignature(tampered, KNOWN_ANSWER, 'test-secret')).toBe(false);
  });

  it('rejects tampering with the farmer', () => {
    const tampered = { ...PAYLOAD, farmerId: 'farmer-2' };
    expect(verifyVoucherSignature(tampered, KNOWN_ANSWER, 'test-secret')).toBe(false);
  });

  it('rejects tampering with the expiry', () => {
    const tampered = { ...PAYLOAD, expiry: '2027-02-01T00:00:00.000Z' };
    expect(verifyVoucherSignature(tampered, KNOWN_ANSWER, 'test-secret')).toBe(false);
  });

  it('rejects tampering with the nonce', () => {
    const tampered = { ...PAYLOAD, nonce: 'nonce-999' };
    expect(verifyVoucherSignature(tampered, KNOWN_ANSWER, 'test-secret')).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifyVoucherSignature(PAYLOAD, 'not-hex', 'test-secret')).toBe(false);
    expect(verifyVoucherSignature(PAYLOAD, '', 'test-secret')).toBe(false);
    expect(verifyVoucherSignature(PAYLOAD, KNOWN_ANSWER.toUpperCase(), 'test-secret')).toBe(false);
  });

  it('signatures differ across voucher ids (no cross-voucher replay)', () => {
    const other = signVoucher({ ...PAYLOAD, voucherId: 'voucher-test-2' }, 'test-secret');
    expect(other).not.toBe(KNOWN_ANSWER);
    expect(verifyVoucherSignature(PAYLOAD, other, 'test-secret')).toBe(false);
  });

  it('resolveVoucherSecret uses the configured secret when present', () => {
    expect(resolveVoucherSecret({ AGENT_VOUCHER_SECRET: 'prod-secret' })).toBe('prod-secret');
  });

  it('resolveVoucherSecret falls back to the labelled dev secret outside production', () => {
    expect(resolveVoucherSecret({ NODE_ENV: 'development' })).toBe(DEV_VOUCHER_SECRET);
    expect(resolveVoucherSecret({})).toBe(DEV_VOUCHER_SECRET);
  });

  it('resolveVoucherSecret fails closed in production without a secret', () => {
    expect(() => resolveVoucherSecret({ NODE_ENV: 'production' })).toThrow(/AGENT_VOUCHER_SECRET/);
  });
});
