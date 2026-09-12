import { describe, expect, it } from 'vitest';
import {
  DEV_QR_SECRET,
  QR_PAYLOAD_VERSION,
  canonicalQrPayload,
  hashPayerAlias,
  resolveQrSecret,
  signQrPayload,
  verifyQrSignature,
  type QrPayload
} from './qr-crypto.js';

/**
 * Dealer QR crypto (Stage 27, Innovation 16): known-answer sign/verify
 * vectors and tamper cases, mirroring the voucher-crypto harness. The
 * known-answer hex below was produced with Node's crypto HMAC-SHA256 over
 * the canonical string — it pins the encoding contract byte-for-byte.
 */

const VECTOR: QrPayload = {
  qrId: 'qr-001',
  agentOrgId: 'agent-001',
  dealerUserId: 'user-001',
  label: 'Mai Agro Dealer Kano',
  issuedAt: '2026-01-15T08:00:00.000Z'
};

// HMAC-SHA256(DEV_QR_SECRET, canonicalQrPayload(VECTOR)) — known answer.
const VECTOR_SIGNATURE = '684f2d32f970625184030b93138f9a6368e63b5a2421b5daf964267c31293870';
// HMAC-SHA256(DEV_QR_SECRET, 'payer-alias.+2348000000002') — known answer.
const VECTOR_ALIAS_HMAC = '18f23714ef01c89ff322268c4095377629ad4a32e5b1a0d9d8ba68c76a896c92';

describe('qr-crypto canonical encoding', () => {
  it('pins the versioned, dot-joined canonical payload (field order is the contract)', () => {
    expect(QR_PAYLOAD_VERSION).toBe('v1');
    expect(canonicalQrPayload(VECTOR)).toBe(
      'v1.qr-001.agent-001.user-001.Mai Agro Dealer Kano.2026-01-15T08:00:00.000Z'
    );
  });

  it('matches the known-answer HMAC-SHA256 signature', () => {
    expect(signQrPayload(VECTOR, DEV_QR_SECRET)).toBe(VECTOR_SIGNATURE);
  });

  it('verifies the known-answer signature', () => {
    expect(verifyQrSignature(VECTOR, VECTOR_SIGNATURE, DEV_QR_SECRET)).toBe(true);
  });

  it('matches the known-answer payer alias fingerprint', () => {
    expect(hashPayerAlias('+2348000000002', DEV_QR_SECRET)).toBe(VECTOR_ALIAS_HMAC);
  });
});

describe('qr-crypto tamper vectors', () => {
  it('rejects a payload whose dealer was swapped', () => {
    expect(
      verifyQrSignature({ ...VECTOR, dealerUserId: 'user-999' }, VECTOR_SIGNATURE, DEV_QR_SECRET)
    ).toBe(false);
  });

  it('rejects a payload rebound to another agent organisation', () => {
    expect(
      verifyQrSignature({ ...VECTOR, agentOrgId: 'agent-999' }, VECTOR_SIGNATURE, DEV_QR_SECRET)
    ).toBe(false);
  });

  it('rejects a payload whose label was rewritten', () => {
    expect(
      verifyQrSignature({ ...VECTOR, label: 'Mai Agro Dealer Kano!' }, VECTOR_SIGNATURE, DEV_QR_SECRET)
    ).toBe(false);
  });

  it('rejects a payload whose qr id was swapped (code substitution)', () => {
    expect(verifyQrSignature({ ...VECTOR, qrId: 'qr-002' }, VECTOR_SIGNATURE, DEV_QR_SECRET)).toBe(false);
  });

  it('rejects a payload whose issuance instant was shifted', () => {
    expect(
      verifyQrSignature({ ...VECTOR, issuedAt: '2026-01-16T08:00:00.000Z' }, VECTOR_SIGNATURE, DEV_QR_SECRET)
    ).toBe(false);
  });

  it('rejects verification under the wrong secret', () => {
    expect(verifyQrSignature(VECTOR, VECTOR_SIGNATURE, 'some-other-secret')).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    expect(verifyQrSignature(VECTOR, 'not-hex', DEV_QR_SECRET)).toBe(false);
    expect(verifyQrSignature(VECTOR, '', DEV_QR_SECRET)).toBe(false);
    expect(verifyQrSignature(VECTOR, VECTOR_SIGNATURE.toUpperCase(), DEV_QR_SECRET)).toBe(false);
    expect(verifyQrSignature(VECTOR, VECTOR_SIGNATURE.slice(0, 63), DEV_QR_SECRET)).toBe(false);
  });
});

describe('resolveQrSecret', () => {
  it('falls back to the labelled development default outside production', () => {
    expect(resolveQrSecret({ NODE_ENV: 'development' })).toBe(DEV_QR_SECRET);
  });

  it('uses the configured secret when present', () => {
    expect(resolveQrSecret({ AGENT_QR_SECRET: 'configured-secret' })).toBe('configured-secret');
  });

  it('fails closed in production without a configured secret', () => {
    expect(() => resolveQrSecret({ NODE_ENV: 'production' })).toThrow();
  });

  it('refuses the published development default in production', () => {
    expect(() => resolveQrSecret({ NODE_ENV: 'production', AGENT_QR_SECRET: DEV_QR_SECRET })).toThrow();
  });

  it('enforces the production length floor', () => {
    expect(() => resolveQrSecret({ NODE_ENV: 'production', AGENT_QR_SECRET: 'short' })).toThrow();
  });
});
