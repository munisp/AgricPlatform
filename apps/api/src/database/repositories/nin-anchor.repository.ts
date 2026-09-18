import { ConflictException } from '@nestjs/common';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Global NIN anchoring (V-45, dim04-H3, migration 088). Programme-level NIN
 * dedupe (input_vouchers.beneficiaries, migration 035) is per-programme only;
 * anchors give an OPTIONAL global identity anchor: one per user, hash-only
 * at rest (never the cleartext NIN), deliberately NOT unique on nin_hash so
 * cross-account duplicates can be DETECTED and merged.
 */
export interface NinAnchor {
  id: string;
  userId: string;
  /** sha256('nin-anchor:' + nin) — cleartext NIN is never stored. */
  ninHash: string;
  status: 'active' | 'merged';
  anchoredAt: string;
  anchoredBy: string;
}

export interface NinAnchorCriteria {
  userId?: string;
  ninHash?: string;
  status?: NinAnchor['status'];
}

export interface NinAnchorRepository extends AsyncRepository<NinAnchor, NinAnchorCriteria> {}

export function ninAnchorMatcher(criteria: NinAnchorCriteria): (anchor: NinAnchor) => boolean {
  return (anchor) =>
    (!criteria.userId || anchor.userId === criteria.userId) &&
    (!criteria.ninHash || anchor.ninHash === criteria.ninHash) &&
    (!criteria.status || anchor.status === criteria.status);
}

export class InMemoryNinAnchorRepository
  extends InMemoryRepository<NinAnchor, NinAnchorCriteria>
  implements NinAnchorRepository
{
  constructor(seed: readonly NinAnchor[] = []) {
    super(seed, ninAnchorMatcher);
  }

  /**
   * Mirror migration 088: one anchor per user (UNIQUE user_id).
   * Synchronous check-and-set so concurrent anchors serialise.
   */
  override async create(anchor: NinAnchor): Promise<NinAnchor> {
    const existing = await this.findOne({ userId: anchor.userId });
    if (existing) {
      throw new ConflictException(`NIN anchor already exists for user ${anchor.userId}`);
    }
    return super.create(anchor);
  }
}

export function createInMemoryNinAnchorRepository(): InMemoryNinAnchorRepository {
  return new InMemoryNinAnchorRepository();
}

/** Append-only merge audit record (V-45): duplicate account folded into primary. */
export interface AccountMerge {
  id: string;
  primaryUserId: string;
  duplicateUserId: string;
  creditLoansMoved: number;
  loanApplicationsMoved: number;
  mergedAt: string;
  mergedBy: string;
  note?: string;
}

export interface AccountMergeCriteria {
  primaryUserId?: string;
  duplicateUserId?: string;
}

export interface AccountMergeRepository
  extends AsyncRepository<AccountMerge, AccountMergeCriteria> {}

export function accountMergeMatcher(criteria: AccountMergeCriteria): (merge: AccountMerge) => boolean {
  return (merge) =>
    (!criteria.primaryUserId || merge.primaryUserId === criteria.primaryUserId) &&
    (!criteria.duplicateUserId || merge.duplicateUserId === criteria.duplicateUserId);
}

export class InMemoryAccountMergeRepository
  extends InMemoryRepository<AccountMerge, AccountMergeCriteria>
  implements AccountMergeRepository
{
  constructor(seed: readonly AccountMerge[] = []) {
    super(seed, accountMergeMatcher);
  }
}

export function createInMemoryAccountMergeRepository(): InMemoryAccountMergeRepository {
  return new InMemoryAccountMergeRepository();
}
