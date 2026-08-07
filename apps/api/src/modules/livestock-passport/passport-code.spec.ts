import { describe, expect, it } from 'vitest';
import {
  canonicalPassportCodePayload,
  DEV_PASSPORT_CODE_SECRET,
  formatPassportCode,
  parsePassportCode,
  resolvePassportCodeSecret,
  signPassportCode,
  verifyPassportCode
} from './passport-code.js';

const SECRET = 'spec-secret-that-is-long-enough';
const PAYLOAD = { passportId: 'lsp-123', animalId: 'NG-BOV-KD-000123', nonce: 'ab12cd34' };

describe('passport-code canonical payload + signing', () => {
  it('encodes the payload in a versioned, fixed order', () => {
    expect(canonicalPassportCodePayload(PAYLOAD)).toBe('v1.lsp-123.NG-BOV-KD-000123.ab12cd34');
  });

  it('signs deterministically as 64-char hex', () => {
    const signature = signPassportCode(PAYLOAD, SECRET);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signPassportCode(PAYLOAD, SECRET)).toBe(signature);
  });

  it('changes the signature when any payload field changes', () => {
    const base = signPassportCode(PAYLOAD, SECRET);
    expect(signPassportCode({ ...PAYLOAD, animalId: 'NG-CAP-KD-000009' }, SECRET)).not.toBe(base);
    expect(signPassportCode({ ...PAYLOAD, nonce: 'ffffffff' }, SECRET)).not.toBe(base);
  });
});

describe('passport-code wire format', () => {
  it('round-trips format → parse', () => {
    const signature = signPassportCode(PAYLOAD, SECRET);
    const code = formatPassportCode(PAYLOAD.animalId, PAYLOAD.nonce, signature);
    expect(code.startsWith('LSP.NG-BOV-KD-000123.ab12cd34.')).toBe(true);
    expect(parsePassportCode(code)).toEqual({
      animalId: PAYLOAD.animalId,
      nonce: PAYLOAD.nonce,
      signaturePrefix: signature.slice(0, 16)
    });
  });

  it('rejects malformed codes', () => {
    expect(parsePassportCode('NG-BOV-KD-000123')).toBeUndefined();
    expect(parsePassportCode('LSP.NG-BOV-KD-000123.nothex!!.' + 'a'.repeat(16))).toBeUndefined();
    expect(parsePassportCode('LSP.NG-BOV-KD-000123.ab12cd34.short')).toBeUndefined();
    expect(parsePassportCode('')).toBeUndefined();
  });
});

describe('verifyPassportCode', () => {
  it('accepts the genuine code', () => {
    const signature = signPassportCode(PAYLOAD, SECRET);
    expect(verifyPassportCode(PAYLOAD, signature.slice(0, 16), signature, SECRET)).toBe(true);
  });

  it('rejects a forged prefix', () => {
    const signature = signPassportCode(PAYLOAD, SECRET);
    expect(verifyPassportCode(PAYLOAD, '0'.repeat(16), signature, SECRET)).toBe(false);
  });

  it('rejects when the stored signature was not signed with the secret', () => {
    const foreign = signPassportCode(PAYLOAD, 'a-different-secret-key');
    expect(verifyPassportCode(PAYLOAD, foreign.slice(0, 16), foreign, SECRET)).toBe(false);
  });

  it('rejects malformed stored signatures and prefixes', () => {
    const signature = signPassportCode(PAYLOAD, SECRET);
    expect(verifyPassportCode(PAYLOAD, 'xyz', signature, SECRET)).toBe(false);
    expect(verifyPassportCode(PAYLOAD, signature.slice(0, 16), 'not-a-signature', SECRET)).toBe(
      false
    );
  });
});

describe('resolvePassportCodeSecret — fail-closed', () => {
  it('returns the labelled dev default outside production', () => {
    expect(resolvePassportCodeSecret({ NODE_ENV: 'development' })).toBe(DEV_PASSPORT_CODE_SECRET);
  });

  it('aborts in production without a configured secret', () => {
    expect(() => resolvePassportCodeSecret({ NODE_ENV: 'production' })).toThrow(
      /LIVESTOCK_PASSPORT_SECRET/
    );
  });

  it('aborts in production with a too-short secret', () => {
    expect(() =>
      resolvePassportCodeSecret({ NODE_ENV: 'production', LIVESTOCK_PASSPORT_SECRET: 'short' })
    ).toThrow(/LIVESTOCK_PASSPORT_SECRET/);
  });

  it('returns the configured secret in production', () => {
    const secret = 'prod-secret-with-plenty-of-entropy';
    expect(
      resolvePassportCodeSecret({ NODE_ENV: 'production', LIVESTOCK_PASSPORT_SECRET: secret })
    ).toBe(secret);
  });
});
