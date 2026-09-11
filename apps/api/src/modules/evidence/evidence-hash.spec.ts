import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@agric-platform/shared';
import {
  chainHead,
  EVIDENCE_GENESIS_HASH,
  evidenceItemPayload,
  evidenceSizeClass,
  hashEvidenceItem,
  linkEvidenceItem,
  verifyEvidenceChain
} from './evidence-hash.js';

/**
 * Known-answer vectors for the evidence hash chain. The expected digests
 * below were computed INDEPENDENTLY of this codebase (Python hashlib over
 * a hand-written canonical-JSON encoder) from the fixtures here — a change
 * to field naming, canonicalization, or the chain recipe breaks them.
 */

const GENESIS = '0'.repeat(64);

function itemOne(): Omit<EvidenceItem, 'prevHash' | 'itemHash'> {
  return {
    id: 'evi-1',
    caseType: 'escrow',
    caseId: 'escrow-1',
    uploaderId: 'user-buyer',
    objectKey: 'evidence/escrow/escrow-1/evi-1',
    sha256: 'a'.repeat(64),
    capturedAt: null,
    uploadedAt: '2026-09-01T10:00:00.000Z',
    mime: 'image/jpeg',
    sizeBytes: 1024,
    status: 'active'
  };
}

function itemTwo(): Omit<EvidenceItem, 'prevHash' | 'itemHash'> {
  return {
    id: 'evi-2',
    caseType: 'escrow',
    caseId: 'escrow-1',
    uploaderId: 'user-seller',
    objectKey: 'evidence/escrow/escrow-1/evi-2',
    sha256: 'b'.repeat(64),
    capturedAt: '2026-09-01T09:58:00.000Z',
    uploadedAt: '2026-09-01T10:05:00.000Z',
    mime: 'image/png',
    sizeBytes: 2048,
    status: 'active'
  };
}

const ITEM_ONE_HASH = '596f9d555d6c334b1b2878116dac5a92e88bd003ff2b40b00d95fa5179048739';
const ITEM_TWO_HASH = '5ede4204ed852d3cfa75dee29bc6379383f5b98ebb13a2fcdcc6597f9ce28e4b';

describe('evidence hash chain — known answers', () => {
  it('uses the 64-zero genesis shared with the audit chain', () => {
    expect(EVIDENCE_GENESIS_HASH).toBe(GENESIS);
  });

  it('links the genesis item to the known digest', () => {
    const linked = linkEvidenceItem(itemOne(), GENESIS);
    expect(linked.prevHash).toBe(GENESIS);
    expect(linked.itemHash).toBe(ITEM_ONE_HASH);
  });

  it('links the second item to the known digest over the first', () => {
    const first = linkEvidenceItem(itemOne(), GENESIS);
    const second = linkEvidenceItem(itemTwo(), first.itemHash);
    expect(second.prevHash).toBe(ITEM_ONE_HASH);
    expect(second.itemHash).toBe(ITEM_TWO_HASH);
  });

  it('hashEvidenceItem recomputes the stored digest from the payload', () => {
    const linked = linkEvidenceItem(itemOne(), GENESIS);
    expect(hashEvidenceItem(evidenceItemPayload(linked))).toBe(linked.itemHash);
  });
});

describe('verifyEvidenceChain — linkage and tamper detection', () => {
  function chainOfTwo(): EvidenceItem[] {
    const first = linkEvidenceItem(itemOne(), GENESIS);
    const second = linkEvidenceItem(itemTwo(), first.itemHash);
    return [first, second];
  }

  it('verifies a clean chain and reports the head hash', () => {
    const chain = chainOfTwo();
    const result = verifyEvidenceChain(chain);
    expect(result).toEqual({ valid: true, checked: 2, tamperedItemIds: [] });
    expect(chainHead(chain)).toBe(ITEM_TWO_HASH);
    expect(chainHead([])).toBe(GENESIS);
  });

  it('detects a payload edit (hash mismatch) and flags the item', () => {
    const chain = chainOfTwo();
    chain[0] = { ...chain[0], sizeBytes: 9999 }; // rewrite provenance
    const result = verifyEvidenceChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe('evi-1');
    expect(result.tamperedItemIds).toEqual(['evi-1']);
    expect(result.checked).toBe(0);
  });

  it('detects a deleted middle item (link break)', () => {
    const chain = chainOfTwo();
    const result = verifyEvidenceChain([chain[1]]); // evi-1 deleted
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe('evi-2');
    expect(result.tamperedItemIds).toEqual(['evi-2']);
  });

  it('detects a fork (two items claiming the same parent)', () => {
    const chain = chainOfTwo();
    const fork = linkEvidenceItem(
      { ...itemTwo(), id: 'evi-fork', objectKey: 'evidence/escrow/escrow-1/evi-fork' },
      chain[0].itemHash
    );
    const result = verifyEvidenceChain([chain[0], fork, chain[1]]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe('evi-2');
  });

  it('survives status transitions: sealed/expunged items still verify (tombstone semantics)', () => {
    const [first, second] = chainOfTwo();
    const sealed = { ...first, status: 'sealed' as const };
    const expunged = { ...second, status: 'expunged' as const };
    const result = verifyEvidenceChain([sealed, expunged]);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });

  it('status is excluded from the hashed payload', () => {
    const active = linkEvidenceItem(itemOne(), GENESIS);
    const tombstone: EvidenceItem = { ...active, status: 'expunged' };
    expect(hashEvidenceItem(evidenceItemPayload(tombstone))).toBe(ITEM_ONE_HASH);
  });
});

describe('evidenceSizeClass', () => {
  it('buckets sizes without leaking raw bytes to telemetry', () => {
    expect(evidenceSizeClass(1)).toBe('le_64kib');
    expect(evidenceSizeClass(64 * 1024)).toBe('le_64kib');
    expect(evidenceSizeClass(64 * 1024 + 1)).toBe('le_1mib');
    expect(evidenceSizeClass(1024 * 1024)).toBe('le_1mib');
    expect(evidenceSizeClass(5 * 1024 * 1024)).toBe('le_10mib');
    expect(evidenceSizeClass(50 * 1024 * 1024)).toBe('gt_10mib');
  });
});
