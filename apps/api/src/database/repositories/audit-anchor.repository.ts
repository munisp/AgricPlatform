import type { AuditAnchor } from '@agric-platform/shared';
import { chainTimestamp, GENESIS_HASH, linkAuditAnchor } from '../../core/audit-chain.js';

/**
 * Anchoring checkpoint log (audit.anchors, Stage 23 — closes the tail
 * truncation residual documented in migration 043). Anchors notarize the
 * audit event chain tip (event id + tip hash + event count) and form their
 * own hash chain so anchor history is itself tamper-evident.
 *
 * Chain-extension contract mirrors AuditRepository: `append()` is the ONLY
 * write path for new anchors. It must derive prevAnchorHash from the latest
 * persisted anchor and persist the linked anchor atomically — no
 * interleavable read-then-write. `record()` remains as a trusted raw insert
 * for tests/tooling that inject fully-hashed (e.g. forged) anchor history.
 */
export interface AuditAnchorRepository {
  /** Atomically extends the anchor chain with a new anchor. */
  append(anchor: Omit<AuditAnchor, 'prevAnchorHash' | 'anchorHash'>): Promise<AuditAnchor>;
  /** Raw trusted insert of a fully-hashed anchor (tests/tooling only). */
  record(anchor: AuditAnchor): Promise<AuditAnchor>;
  /** Latest anchor by (createdAt, id), or null before the first anchor. */
  latest(): Promise<AuditAnchor | null>;
  /** All anchors in chain order (createdAt, id). */
  list(): Promise<AuditAnchor[]>;
}

export class InMemoryAuditAnchorRepository implements AuditAnchorRepository {
  private readonly anchors: AuditAnchor[] = [];

  async append(unsigned: Omit<AuditAnchor, 'prevAnchorHash' | 'anchorHash'>): Promise<AuditAnchor> {
    // The whole read-tip → link → push sequence is synchronous (no awaits),
    // so concurrent append() calls run to completion one at a time and can
    // never interleave into a forked anchor chain — the single-process
    // analogue of the database's UNIQUE(prev_anchor_hash) serialization.
    const tip = this.anchors[this.anchors.length - 1];
    // Keep anchor order aligned with (createdAt, id) ordering even when
    // concurrent creators share a millisecond.
    const createdAt = chainTimestamp(tip?.createdAt, unsigned.createdAt);
    const anchor = linkAuditAnchor({ ...unsigned, createdAt }, tip?.anchorHash ?? GENESIS_HASH);
    this.anchors.push(anchor);
    return anchor;
  }

  async record(anchor: AuditAnchor): Promise<AuditAnchor> {
    this.anchors.push(anchor);
    return anchor;
  }

  async latest(): Promise<AuditAnchor | null> {
    return this.anchors[this.anchors.length - 1] ?? null;
  }

  async list(): Promise<AuditAnchor[]> {
    return [...this.anchors];
  }
}

export function createInMemoryAuditAnchorRepository(): InMemoryAuditAnchorRepository {
  return new InMemoryAuditAnchorRepository();
}
