import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertSameIdempotencyPayload,
  hashIdempotencyPayload
} from './payload-hash.js';

/** WP-G11: canonical payload fingerprint + replay-guard unit contract. */
describe('hashIdempotencyPayload', () => {
  it('fingerprints identically regardless of key order', () => {
    const a = hashIdempotencyPayload({ memberId: 'm1', amountKobo: 100, cycleId: 'c1' });
    const b = hashIdempotencyPayload({ cycleId: 'c1', amountKobo: 100, memberId: 'm1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes any payload difference', () => {
    const base = hashIdempotencyPayload({ amountKobo: 100, memberId: 'm1' });
    expect(hashIdempotencyPayload({ amountKobo: 101, memberId: 'm1' })).not.toBe(base);
    expect(hashIdempotencyPayload({ amountKobo: 100, memberId: 'm2' })).not.toBe(base);
    expect(hashIdempotencyPayload({ amountKobo: '100', memberId: 'm1' })).not.toBe(base);
  });

  it('drops undefined fields but keeps explicit nulls', () => {
    const withUndefined = hashIdempotencyPayload({ a: 1, b: undefined });
    const plain = hashIdempotencyPayload({ a: 1 });
    const withNull = hashIdempotencyPayload({ a: 1, b: null });
    expect(withUndefined).toBe(plain);
    expect(withNull).not.toBe(plain);
  });
});

describe('assertSameIdempotencyPayload', () => {
  it('passes on hash equality and on legacy hashless records', () => {
    const hash = hashIdempotencyPayload({ x: 1 });
    expect(() => assertSameIdempotencyPayload('k', hash, hash)).not.toThrow();
    expect(() => assertSameIdempotencyPayload('k', undefined, hash)).not.toThrow();
  });

  it('409s IDEMPOTENCY_PAYLOAD_MISMATCH on divergence', () => {
    const stored = hashIdempotencyPayload({ x: 1 });
    const incoming = hashIdempotencyPayload({ x: 2 });
    expect(() => assertSameIdempotencyPayload('k', stored, incoming)).toThrowError(
      ConflictException
    );
    expect(() => assertSameIdempotencyPayload('k', stored, incoming)).toThrowError(
      /IDEMPOTENCY_PAYLOAD_MISMATCH/
    );
  });
});
