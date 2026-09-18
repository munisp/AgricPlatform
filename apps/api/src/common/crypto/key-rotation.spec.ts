import { describe, expect, it } from 'vitest';
import {
  hmacSign,
  hmacVerify,
  keyedHash,
  KeyRingConfigError,
  matchKeyedHash,
  parseKeyRingSpec,
  resolveHmacKeyRing,
  type HmacKeyRing
} from './key-rotation.js';
import { signVoucherEnvelope, verifyVoucherEnvelope } from '../../modules/agent-banking/voucher-crypto.js';

/**
 * V-26: key-versioned envelope mechanism — kid in payload, active+previous
 * acceptance window, retired-key rejection, dual-salt hash lookup.
 */

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);
const SECRET_C = 'c'.repeat(48);

/** Ring during a rotation window: A is active (signs), B is previous. */
function windowRing(): HmacKeyRing {
  return {
    active: { kid: '2026-06-a', secret: SECRET_A },
    previous: [{ kid: '2025-12-b', secret: SECRET_B }],
    purpose: 'test ring'
  };
}

describe('hmacSign/hmacVerify envelope (V-26)', () => {
  it('signs with the ACTIVE key and embeds the kid in the envelope', () => {
    const ring = windowRing();
    const signature = hmacSign(ring, 'payload');
    expect(signature).toMatch(/^2026-06-a:[0-9a-f]{64}$/);
    expect(hmacVerify(ring, 'payload', signature)).toEqual({
      ok: true,
      kid: '2026-06-a',
      mode: 'active'
    });
  });

  it('accepts signatures from the PREVIOUS key during the rotation window', () => {
    const ring = windowRing();
    // A payload signed BEFORE rotation, when B was still active.
    const oldSignature = `2025-12-b:${hmacSign(
      { active: { kid: '2025-12-b', secret: SECRET_B }, previous: [], purpose: 't' },
      'payload'
    ).split(':')[1]}`;
    expect(hmacVerify(ring, 'payload', oldSignature)).toEqual({
      ok: true,
      kid: '2025-12-b',
      mode: 'previous'
    });
  });

  it('rejects a RETIRED key (kid not in the ring) with a distinct reason', () => {
    const ring = windowRing();
    // C was retired before B — no longer in the acceptance window.
    const retiredRing: HmacKeyRing = {
      active: { kid: '2024-01-c', secret: SECRET_C },
      previous: [],
      purpose: 't'
    };
    const retiredSignature = hmacSign(retiredRing, 'payload');
    const result = hmacVerify(ring, 'payload', retiredSignature);
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'retired-kid' });
  });

  it('rejects tampered payloads (mismatch) and malformed envelopes', () => {
    const ring = windowRing();
    const signature = hmacSign(ring, 'payload');
    expect(hmacVerify(ring, 'tampered', signature)).toEqual({ ok: false, reason: 'mismatch' });
    expect(hmacVerify(ring, 'payload', 'not-an-envelope')).toEqual({
      ok: false,
      reason: 'malformed'
    });
    expect(hmacVerify(ring, 'payload', '2026-06-a:zzzz')).toEqual({
      ok: false,
      reason: 'malformed'
    });
  });

  it('accepts bare-hex legacy signatures only when the legacy window is enabled', () => {
    const ring = windowRing();
    // A pre-kid signature produced under the now-PREVIOUS secret B.
    const bareHex = hmacSign(
      { active: { kid: 'x', secret: SECRET_B }, previous: [], purpose: 't' },
      'payload'
    ).split(':')[1];
    expect(bareHex).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacVerify(ring, 'payload', bareHex, { legacyBareHex: true })).toEqual({
      ok: true,
      kid: '2025-12-b',
      mode: 'legacy'
    });
    // Without the option the same signature is malformed (fielded payloads
    // must carry kids once the window closes).
    expect(hmacVerify(ring, 'payload', bareHex)).toEqual({ ok: false, reason: 'malformed' });
    // Bare hex under an unknown secret never verifies, even with the window on.
    const foreign = hmacSign(
      { active: { kid: 'x', secret: SECRET_C }, previous: [], purpose: 't' },
      'payload'
    ).split(':')[1];
    expect(hmacVerify(ring, 'payload', foreign, { legacyBareHex: true })).toEqual({
      ok: false,
      reason: 'mismatch'
    });
  });
});

describe('dual-salt keyed-hash lookup (V-26, NIN/MSISDN transition)', () => {
  const NIN = '12345678901';
  const data = `nin:v1:${NIN}`;

  it('matches hashes made under the active salt (no rehash needed)', () => {
    const ring = windowRing();
    const stored = keyedHash(ring, data);
    expect(matchKeyedHash(ring, data, stored)).toEqual({
      matched: true,
      matchedKid: '2026-06-a',
      needsRehash: false
    });
  });

  it('matches hashes made under the PREVIOUS salt during the window and flags rehash', () => {
    // Hash stored BEFORE the salt rotation (under B, now previous).
    const oldRing: HmacKeyRing = {
      active: { kid: '2025-12-b', secret: SECRET_B },
      previous: [],
      purpose: 't'
    };
    const stored = keyedHash(oldRing, data);
    const ring = windowRing();
    expect(matchKeyedHash(ring, data, stored)).toEqual({
      matched: true,
      matchedKid: '2025-12-b',
      // Caller must re-hash with the active salt at this presentation —
      // a batch re-hash job is impossible by design (no plaintext stored).
      needsRehash: true
    });
  });

  it('does not match hashes from a retired salt or a wrong NIN', () => {
    const retiredRing: HmacKeyRing = {
      active: { kid: '2024-01-c', secret: SECRET_C },
      previous: [],
      purpose: 't'
    };
    const stored = keyedHash(retiredRing, data);
    expect(matchKeyedHash(windowRing(), data, stored)).toEqual({
      matched: false,
      needsRehash: false
    });
    expect(matchKeyedHash(windowRing(), 'nin:v1:10987654321', keyedHash(windowRing(), data)).matched).toBe(
      false
    );
  });
});

describe('parseKeyRingSpec / resolveHmacKeyRing (V-26 config)', () => {
  it('parses kid=secret pairs: first active, rest previous', () => {
    const keys = parseKeyRingSpec(`2026-06-a=${SECRET_A}, 2025-12-b=${SECRET_B}`, 't');
    expect(keys).toEqual([
      { kid: '2026-06-a', secret: SECRET_A },
      { kid: '2025-12-b', secret: SECRET_B }
    ]);
  });

  it('rejects malformed specs loudly (dup kid, bad kid, empty secret, separators in secret)', () => {
    expect(() => parseKeyRingSpec(`a=x,a=y`, 't')).toThrowError(KeyRingConfigError);
    expect(() => parseKeyRingSpec(`=x`, 't')).toThrowError(KeyRingConfigError);
    expect(() => parseKeyRingSpec(`a=`, 't')).toThrowError(KeyRingConfigError);
    expect(() => parseKeyRingSpec(`a=sec,ret`, 't')).toThrowError(KeyRingConfigError); // ',' splits pairs
    expect(() => parseKeyRingSpec(`a=sec=ret`, 't')).toThrowError(/separator/);
    expect(() => parseKeyRingSpec(``, 't')).toThrowError(/no keys/);
  });

  it('resolves the ring from the KEYS var, falling back to the legacy single-secret var', () => {
    const ring = resolveHmacKeyRing(
      { AGENT_VOUCHER_KEYS: `2026-06-a=${SECRET_A},2025-12-b=${SECRET_B}` },
      {
        keysEnv: 'AGENT_VOUCHER_KEYS',
        legacyEnv: 'AGENT_VOUCHER_SECRET',
        devDefault: 'dev-default',
        purpose: 'voucher'
      }
    );
    expect(ring.active).toEqual({ kid: '2026-06-a', secret: SECRET_A });
    expect(ring.previous).toHaveLength(1);

    const legacy = resolveHmacKeyRing(
      { AGENT_VOUCHER_SECRET: SECRET_A },
      {
        keysEnv: 'AGENT_VOUCHER_KEYS',
        legacyEnv: 'AGENT_VOUCHER_SECRET',
        devDefault: 'dev-default',
        fallbackKid: 'legacy',
        purpose: 'voucher'
      }
    );
    expect(legacy.active.kid).toBe('legacy');
  });

  it('fails closed in production when nothing is configured', () => {
    expect(() =>
      resolveHmacKeyRing(
        { NODE_ENV: 'production' },
        {
          keysEnv: 'AGENT_VOUCHER_KEYS',
          legacyEnv: 'AGENT_VOUCHER_SECRET',
          devDefault: 'dev-default',
          purpose: 'voucher'
        }
      )
    ).toThrowError(/required in production/);
  });

  it('rejects published dev defaults and weak secrets in production, on ANY ring slot', () => {
    const opts = {
      keysEnv: 'AGENT_VOUCHER_KEYS',
      legacyEnv: 'AGENT_VOUCHER_SECRET',
      devDefault: 'agent-banking-dev-voucher-secret-INSECURE',
      purpose: 'voucher',
      publishedDefaults: ['agent-banking-dev-voucher-secret-INSECURE']
    };
    expect(() =>
      resolveHmacKeyRing(
        {
          NODE_ENV: 'production',
          AGENT_VOUCHER_KEYS: `a=${SECRET_A},b=agent-banking-dev-voucher-secret-INSECURE`
        },
        opts
      )
    ).toThrowError(/PUBLISHED/);
    expect(() =>
      resolveHmacKeyRing({ NODE_ENV: 'production', AGENT_VOUCHER_KEYS: `a=short` }, opts)
    ).toThrowError(/at least/);
  });
});

describe('voucher-crypto reference adoption (V-26 end-to-end)', () => {
  const payload = {
    voucherId: 'voucher-1',
    agentId: 'agent-1',
    farmerId: 'farmer-1',
    amountKobo: 500_000,
    expiry: '2027-01-01T00:00:00.000Z',
    nonce: 'nonce-1'
  };

  it('signs with kid=A, verifies A+B during the window, rejects retired C', () => {
    const ringA: HmacKeyRing = { active: { kid: 'A', secret: SECRET_A }, previous: [], purpose: 'v' };
    const signedByA = signVoucherEnvelope(payload, ringA);
    expect(signedByA.startsWith('A:')).toBe(true);

    // Rotation: B becomes active, A slides into the window.
    const ringBA: HmacKeyRing = {
      active: { kid: 'B', secret: SECRET_B },
      previous: [{ kid: 'A', secret: SECRET_A }],
      purpose: 'v'
    };
    expect(verifyVoucherEnvelope(payload, signedByA, ringBA)).toBe(true); // A still accepted
    expect(verifyVoucherEnvelope(payload, signVoucherEnvelope(payload, ringBA), ringBA)).toBe(true);

    // Window closed: A retired → its signatures are rejected.
    const ringBOnly: HmacKeyRing = {
      active: { kid: 'B', secret: SECRET_B },
      previous: [],
      purpose: 'v'
    };
    expect(verifyVoucherEnvelope(payload, signedByA, ringBOnly)).toBe(false);

    // A foreign/retired key C never verifies in any window.
    const ringC: HmacKeyRing = { active: { kid: 'C', secret: SECRET_C }, previous: [], purpose: 'v' };
    const signedByC = signVoucherEnvelope(payload, ringC);
    expect(verifyVoucherEnvelope(payload, signedByC, ringBA)).toBe(false);
  });

  it('legacy bare-hex signatures keep verifying during the transition window', () => {
    const ringA: HmacKeyRing = { active: { kid: 'A', secret: SECRET_A }, previous: [], purpose: 'v' };
    // Pre-envelope signature: bare hex under secret A.
    const bareHex = signVoucherEnvelope(payload, ringA).split(':')[1];
    const rotated: HmacKeyRing = {
      active: { kid: 'B', secret: SECRET_B },
      previous: [{ kid: 'A', secret: SECRET_A }],
      purpose: 'v'
    };
    expect(verifyVoucherEnvelope(payload, bareHex, rotated)).toBe(true);
    // Tampered payload with the legacy signature still fails.
    expect(
      verifyVoucherEnvelope({ ...payload, amountKobo: 5_000_000 }, bareHex, rotated)
    ).toBe(false);
  });
});
