import { describe, expect, it } from 'vitest';
import {
  DEV_NIN_HASH_SALT,
  InvalidNinError,
  hashNin,
  maskNin,
  normalizeNin,
  resolveNinHashSalt
} from './nin-crypto.js';

const NIN = '12345678901';

describe('nin-crypto (wave NINVOUCHER)', () => {
  it('normalises NINs with spaces or hyphens', () => {
    expect(normalizeNin('1234 5678 901')).toBe(NIN);
    expect(normalizeNin('1234-5678-901')).toBe(NIN);
  });

  it('rejects malformed NINs', () => {
    for (const bad of ['', '123', '123456789012', 'abcdefghijk', '1234567890a']) {
      expect(() => normalizeNin(bad), bad).toThrow(InvalidNinError);
    }
  });

  it('hashes deterministically for the same NIN + salt', () => {
    expect(hashNin(NIN, 'salt-a')).toBe(hashNin('1234 5678 901', 'salt-a'));
    expect(hashNin(NIN, 'salt-a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different salts produce different hashes (unkeyed hashes are reversible)', () => {
    expect(hashNin(NIN, 'salt-a')).not.toBe(hashNin(NIN, 'salt-b'));
  });

  it('different NINs produce different hashes', () => {
    expect(hashNin(NIN, 'salt-a')).not.toBe(hashNin('10987654321', 'salt-a'));
  });

  it('the hash never contains the plaintext NIN', () => {
    const hash = hashNin(NIN, 'salt-a');
    expect(hash).not.toContain(NIN);
    expect(hash).not.toContain(NIN.slice(0, 6));
  });

  it('masks to the last 3 digits only', () => {
    expect(maskNin(NIN)).toBe('********901');
    expect(maskNin('1234-5678-901')).toBe('********901');
  });

  it('masking rejects malformed NINs', () => {
    expect(() => maskNin('123')).toThrow(InvalidNinError);
  });

  it('resolveNinHashSalt returns the clearly-labelled dev default outside production', () => {
    expect(resolveNinHashSalt({ NODE_ENV: 'development' })).toBe(DEV_NIN_HASH_SALT);
    expect(resolveNinHashSalt({})).toBe(DEV_NIN_HASH_SALT);
  });

  it('resolveNinHashSalt uses the configured salt', () => {
    expect(resolveNinHashSalt({ NIN_HASH_SALT: 'real-salt' })).toBe('real-salt');
  });

  it('resolveNinHashSalt fails closed in production without a salt', () => {
    expect(() => resolveNinHashSalt({ NODE_ENV: 'production' })).toThrow(/NIN_HASH_SALT/);
  });

  it('resolveNinHashSalt accepts a configured salt in production', () => {
    const salt = 'prod-nin-salt-with-32-chars-min!';
    expect(resolveNinHashSalt({ NODE_ENV: 'production', NIN_HASH_SALT: salt })).toBe(salt);
  });
});
