import { describe, expect, it } from 'vitest';
import { GENESIS_PREV_HASH as TRACEABILITY_GENESIS } from '../traceability/traceability.types.js';
import {
  computePassportEventHash,
  GENESIS_PREV_HASH,
  passportHashPayloadOf,
  verifyPassportChain,
  type PassportEvent
} from './passport.types.js';

function makeEvent(overrides: Partial<PassportEvent> = {}): PassportEvent {
  const unsigned = {
    passportId: 'lsp-1',
    seq: 0,
    type: 'ISSUED' as const,
    actorId: 'farmer-1',
    payload: { animalId: 'NG-BOV-KD-000123' },
    prevEventHash: GENESIS_PREV_HASH,
    ...overrides
  };
  return {
    id: overrides.id ?? 'lspe-1',
    ...unsigned,
    eventHash: computePassportEventHash(passportHashPayloadOf(unsigned)),
    createdAt: '2026-08-01T00:00:00.000Z'
  };
}

function chainOf(length: number): PassportEvent[] {
  const events: PassportEvent[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let seq = 0; seq < length; seq += 1) {
    const event = makeEvent({
      id: `lspe-${seq}`,
      seq,
      type: seq === 0 ? 'ISSUED' : 'TRANSFER_INITIATED',
      prevEventHash: prev
    });
    events.push(event);
    prev = event.eventHash;
  }
  return events;
}

describe('passport hash chain (traceability pattern)', () => {
  it('reuses the traceability genesis prev-hash', () => {
    expect(GENESIS_PREV_HASH).toBe(TRACEABILITY_GENESIS);
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
  });

  it('computes a deterministic sha256 over the canonical payload', () => {
    const payload = passportHashPayloadOf(makeEvent());
    const hash = computePassportEventHash(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePassportEventHash(payload)).toBe(hash);
  });

  it('is insensitive to event payload key ordering (canonical JSON)', () => {
    const a = passportHashPayloadOf(
      makeEvent({ payload: { animalId: 'NG-1', transferId: 't-1' } })
    );
    const b = passportHashPayloadOf(
      makeEvent({ payload: { transferId: 't-1', animalId: 'NG-1' } })
    );
    expect(computePassportEventHash(a)).toBe(computePassportEventHash(b));
  });

  it('verifies a well-formed chain', () => {
    const events = chainOf(3);
    const verification = verifyPassportChain('lsp-1', events);
    expect(verification.valid).toBe(true);
    expect(verification.eventCount).toBe(3);
    expect(verification.headHash).toBe(events[2].eventHash);
  });

  it('verifies regardless of storage order (sorted by seq)', () => {
    const events = chainOf(3).reverse();
    expect(verifyPassportChain('lsp-1', events).valid).toBe(true);
  });

  it('detects payload tampering at the event and every descendant', () => {
    const events = chainOf(3);
    events[1] = { ...events[1], payload: { animalId: 'NG-FORGED' } };
    const verification = verifyPassportChain('lsp-1', events);
    expect(verification.valid).toBe(false);
    expect(verification.events[1].hashValid).toBe(false);
    expect(verification.events[2].prevLinkValid).toBe(true); // link intact, hash broken
  });

  it('detects chain surgery (rewritten prev link)', () => {
    const events = chainOf(2);
    events[1] = makeEvent({
      id: 'lspe-1',
      seq: 1,
      type: 'TRANSFER_INITIATED',
      prevEventHash: 'f'.repeat(64)
    });
    const verification = verifyPassportChain('lsp-1', events);
    expect(verification.valid).toBe(false);
    expect(verification.events[1].prevLinkValid).toBe(false);
  });

  it('detects a seq gap', () => {
    const events = chainOf(3);
    const gapped = [events[0], events[2]];
    const verification = verifyPassportChain('lsp-1', gapped);
    expect(verification.valid).toBe(false);
    expect(verification.events[1].prevLinkValid).toBe(false);
  });

  it('treats an empty chain as valid with no head hash', () => {
    const verification = verifyPassportChain('lsp-1', []);
    expect(verification).toMatchObject({ eventCount: 0, valid: true, headHash: undefined });
  });
});
