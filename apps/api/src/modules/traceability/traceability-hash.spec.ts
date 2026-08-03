import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeEventHash,
  GENESIS_PREV_HASH,
  hashPayloadOf,
  verifyLotChain,
  type CustodyEvent,
  type CustodyHashPayload
} from './traceability.types.js';

/**
 * Hash-chain known-answer vectors and tamper detection (wave-eudr). The
 * vectors pin the canonicalisation rules documented in
 * docs/eudr-traceability.md: recursive key sort, no whitespace, undefined
 * dropped, null explicit.
 */

const VECTOR_PAYLOAD: CustodyHashPayload = {
  actorId: 'user-1',
  h3Cell: null,
  latitude: 11.0855,
  longitude: 7.7199,
  lotId: 'lot-1',
  note: null,
  occurredAt: '2026-01-01T00:00:00.000Z',
  parentLotIds: [],
  prevEventHash: GENESIS_PREV_HASH,
  quantity: 100,
  seq: 0,
  type: 'CREATED',
  unit: 'kg'
};

// sha256 over the canonical JSON string, computed independently:
// echo -n '{"actorId":"user-1",...}' | sha256sum (see docs/eudr-traceability.md)
const VECTOR_CANONICAL =
  '{"actorId":"user-1","h3Cell":null,"latitude":11.0855,"longitude":7.7199,"lotId":"lot-1",' +
  '"note":null,"occurredAt":"2026-01-01T00:00:00.000Z","parentLotIds":[],' +
  '"prevEventHash":"0000000000000000000000000000000000000000000000000000000000000000",' +
  '"quantity":100,"seq":0,"type":"CREATED","unit":"kg"}';
const VECTOR_HASH = '78ed49017f82cc6cd21d12dc0aa22d477a1a5f79bf4425615851ee316235fb2f';

function makeEvent(overrides: Partial<CustodyEvent> = {}): CustodyEvent {
  const unsigned = {
    lotId: 'lot-1',
    seq: 0,
    type: 'CREATED' as const,
    actorId: 'user-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    latitude: 11.0855,
    longitude: 7.7199,
    parentLotIds: [],
    prevEventHash: GENESIS_PREV_HASH
  };
  const merged = { ...unsigned, ...overrides };
  return {
    id: 'evt-1',
    ...merged,
    eventHash: computeEventHash(hashPayloadOf(merged)),
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('canonicalJson', () => {
  it('sorts object keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    );
  });

  it('keeps null explicit and preserves array order', () => {
    expect(canonicalJson({ a: null, b: [3, 1, { z: 1, y: 2 }] })).toBe(
      '{"a":null,"b":[3,1,{"y":2,"z":1}]}'
    );
  });

  it('matches the documented canonical vector byte-for-byte', () => {
    expect(canonicalJson(VECTOR_PAYLOAD)).toBe(VECTOR_CANONICAL);
  });
});

describe('computeEventHash (known-answer)', () => {
  it('reproduces the pinned sha256 vector', () => {
    expect(computeEventHash(VECTOR_PAYLOAD)).toBe(VECTOR_HASH);
  });

  it('hashPayloadOf normalises absent optionals to null (stable hashing)', () => {
    const withUndef = hashPayloadOf({
      lotId: 'lot-1',
      seq: 0,
      type: 'CREATED',
      actorId: 'user-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      latitude: 11.0855,
      longitude: 7.7199,
      parentLotIds: [],
      prevEventHash: GENESIS_PREV_HASH
    });
    expect(computeEventHash(withUndef)).toBe(VECTOR_HASH);
  });

  it('sorts parentLotIds inside the hashed payload', () => {
    const a = hashPayloadOf({
      lotId: 'lot-x',
      seq: 0,
      type: 'AGGREGATED',
      actorId: 'user-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      latitude: 1,
      longitude: 2,
      parentLotIds: ['lot-b', 'lot-a'],
      prevEventHash: GENESIS_PREV_HASH
    });
    const b = hashPayloadOf({
      lotId: 'lot-x',
      seq: 0,
      type: 'AGGREGATED',
      actorId: 'user-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      latitude: 1,
      longitude: 2,
      parentLotIds: ['lot-a', 'lot-b'],
      prevEventHash: GENESIS_PREV_HASH
    });
    expect(computeEventHash(a)).toBe(computeEventHash(b));
  });
});

describe('verifyLotChain', () => {
  it('accepts a valid two-event chain (genesis prev for the first event)', () => {
    const first = makeEvent();
    const second = makeEvent({
      id: 'evt-2',
      seq: 1,
      type: 'SHIPPED',
      prevEventHash: first.eventHash
    });
    const result = verifyLotChain('lot-1', [second, first]); // order-independent input
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(2);
    expect(result.events.map((event) => event.seq)).toEqual([0, 1]);
  });

  it('accepts an empty chain as vacuously valid', () => {
    const result = verifyLotChain('lot-1', []);
    expect(result.valid).toBe(true);
    expect(result.eventCount).toBe(0);
  });

  it('detects payload tampering: flipping one coordinate byte breaks the hash', () => {
    const first = makeEvent();
    const tampered: CustodyEvent = { ...first, latitude: first.latitude + 0.0001 };
    const result = verifyLotChain('lot-1', [tampered]);
    expect(result.valid).toBe(false);
    expect(result.events[0].hashValid).toBe(false);
    expect(result.events[0].prevLinkValid).toBe(true);
    expect(result.events[0].expectedHash).not.toBe(result.events[0].storedHash);
  });

  it('detects a forged prev link', () => {
    const forged = makeEvent({ prevEventHash: 'f'.repeat(64) });
    const result = verifyLotChain('lot-1', [forged]);
    expect(result.valid).toBe(false);
    expect(result.events[0].prevLinkValid).toBe(false);
  });

  it('detects a rewritten descendant after the first event is tampered', () => {
    const first = makeEvent();
    const second = makeEvent({ id: 'evt-2', seq: 1, type: 'SHIPPED', prevEventHash: first.eventHash });
    const tamperedFirst: CustodyEvent = { ...first, note: 'rewritten history' };
    // second still points at the ORIGINAL first hash — both events must fail.
    const result = verifyLotChain('lot-1', [tamperedFirst, second]);
    expect(result.valid).toBe(false);
    expect(result.events[0].hashValid).toBe(false);
    expect(result.events[1].prevLinkValid).toBe(false);
  });

  it('detects a seq gap (deleted event)', () => {
    const first = makeEvent();
    const second = makeEvent({ id: 'evt-2', seq: 1, type: 'SHIPPED', prevEventHash: first.eventHash });
    const result = verifyLotChain('lot-1', [second]); // first event deleted
    expect(result.valid).toBe(false);
    expect(result.events[0].prevLinkValid).toBe(false);
  });
});
