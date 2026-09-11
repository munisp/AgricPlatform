import { ConflictException } from '@nestjs/common';
import type { EvidenceCaseType, EvidenceItem, EvidenceItemStatus } from '@agric-platform/shared';
import { chainTimestamp } from '../../core/audit-chain.js';
import { EVIDENCE_GENESIS_HASH, linkEvidenceItem } from '../../modules/evidence/evidence-hash.js';

/**
 * Evidence Locker item log (evidence.items, Stage 27 Innovation 13,
 * migration 071). One hash chain PER CASE (caseType, caseId), same
 * doctrine as the audit chain:
 *
 *   * `append()` is the ONLY creation path. It derives prevHash from the
 *     case's current tip and persists the linked item atomically — no
 *     interleavable read-then-write (UNIQUE (case_type, case_id, prev_hash)
 *     + guarded INSERT on PostgreSQL; a synchronous link-and-push here).
 *   * Append-only: there is intentionally NO general update method. The
 *     only mutations are the two guarded CAS status transitions —
 *     `sealCase()` (active -> sealed for the whole case) and
 *     `transitionStatus()` (active|sealed -> expunged for one item, the
 *     NDPA tombstone). `status` is excluded from the hashed payload, so
 *     neither transition disturbs chain verifiability.
 *   * One storage object = one row: appending with an objectKey that is
 *     already recorded throws ConflictException (UNIQUE object_key).
 */
export interface EvidenceItemRepository {
  /** Atomically extends the case's chain; prevHash is derived, never trusted. */
  append(item: Omit<EvidenceItem, 'prevHash' | 'itemHash'>): Promise<EvidenceItem>;
  /** All items of a case in chain order (uploadedAt, id). */
  listCaseItems(caseType: EvidenceCaseType, caseId: string): Promise<EvidenceItem[]>;
  findById(id: string): Promise<EvidenceItem | undefined>;
  findByObjectKey(objectKey: string): Promise<EvidenceItem | undefined>;
  /** CAS active -> sealed for every item of the case; returns the count moved. */
  sealCase(caseType: EvidenceCaseType, caseId: string): Promise<number>;
  /**
   * Guarded CAS: moves one item from an allowed current status to `to`.
   * Returns undefined when the precondition no longer holds (concurrent
   * transition won the race); the caller surfaces 409, never a silent skip.
   */
  transitionStatus(
    id: string,
    from: EvidenceItemStatus[],
    to: EvidenceItemStatus
  ): Promise<EvidenceItem | undefined>;
  /** Items uploaded by a user (NDPA expunge sweep), any status. */
  listByUploader(uploaderId: string): Promise<EvidenceItem[]>;
}

export class InMemoryEvidenceItemRepository implements EvidenceItemRepository {
  private readonly items: EvidenceItem[] = [];

  async append(unsigned: Omit<EvidenceItem, 'prevHash' | 'itemHash'>): Promise<EvidenceItem> {
    // The whole read-tip -> link -> push sequence is synchronous (no
    // awaits), so concurrent appends cannot interleave into a per-case fork
    // — the single-process analogue of UNIQUE (case_type, case_id,
    // prev_hash) serialization.
    const caseItems = this.caseItems(unsigned.caseType, unsigned.caseId);
    if (this.items.some((item) => item.objectKey === unsigned.objectKey)) {
      throw new ConflictException(
        `Evidence object '${unsigned.objectKey}' is already recorded`
      );
    }
    const tip = caseItems[caseItems.length - 1];
    const uploadedAt = chainTimestamp(tip?.uploadedAt, unsigned.uploadedAt);
    const linked = linkEvidenceItem(
      { ...unsigned, uploadedAt },
      tip?.itemHash ?? EVIDENCE_GENESIS_HASH
    );
    this.items.push(linked);
    return linked;
  }

  async listCaseItems(caseType: EvidenceCaseType, caseId: string): Promise<EvidenceItem[]> {
    return this.caseItems(caseType, caseId).map((item) => ({ ...item }));
  }

  async findById(id: string): Promise<EvidenceItem | undefined> {
    const found = this.items.find((item) => item.id === id);
    return found ? { ...found } : undefined;
  }

  async findByObjectKey(objectKey: string): Promise<EvidenceItem | undefined> {
    const found = this.items.find((item) => item.objectKey === objectKey);
    return found ? { ...found } : undefined;
  }

  async sealCase(caseType: EvidenceCaseType, caseId: string): Promise<number> {
    let moved = 0;
    for (const item of this.items) {
      if (item.caseType === caseType && item.caseId === caseId && item.status === 'active') {
        item.status = 'sealed';
        moved += 1;
      }
    }
    return moved;
  }

  async transitionStatus(
    id: string,
    from: EvidenceItemStatus[],
    to: EvidenceItemStatus
  ): Promise<EvidenceItem | undefined> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || !from.includes(item.status)) {
      return undefined;
    }
    item.status = to;
    return { ...item };
  }

  async listByUploader(uploaderId: string): Promise<EvidenceItem[]> {
    return this.items
      .filter((item) => item.uploaderId === uploaderId)
      .map((item) => ({ ...item }));
  }

  private caseItems(caseType: EvidenceCaseType, caseId: string): EvidenceItem[] {
    return this.items.filter((item) => item.caseType === caseType && item.caseId === caseId);
  }
}

export function createInMemoryEvidenceItemRepository(): InMemoryEvidenceItemRepository {
  return new InMemoryEvidenceItemRepository();
}
