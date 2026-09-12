import { ConflictException, NotFoundException } from '@nestjs/common';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import type {
  PoolContribution,
  PoolListing,
  PoolSplitMarker,
  PoolStatus
} from '../../modules/marketplace/coop-pool.js';

/**
 * Coop Pool & Split persistence ports (Stage 27 Batch 1, Innovation 2).
 *
 * The pg implementation owns the settlement transaction: marker claim
 * (targetless ON CONFLICT DO NOTHING) + pool status CAS + the balanced
 * ledger transfer with all member credit postings + the outbox event commit
 * in ONE database transaction (settleSplit). The in-memory implementation
 * keeps the same semantics synchronously for unit tests / dev without
 * DATABASE_URL: the marker claim is the arbiter and CoopPoolService posts
 * the journal through LedgerService (idempotency-keyed) before finalizing
 * the pool state.
 */

export interface PoolCriteria {
  cooperativeId?: string;
  listingId?: string;
  status?: PoolStatus;
}

export interface ContributionCriteria {
  poolId?: string;
  memberUserId?: string;
  status?: PoolContribution['status'];
}

/** Everything the settlement transaction persists atomically. */
export interface CoopPoolSplitInput {
  poolId: string;
  marker: PoolSplitMarker;
  /** Balanced journal entry (DR clearing, CR member accounts). */
  entry: LedgerJournalEntry;
  /** Expected escrow id + amount; re-verified against the row in the tx. */
  escrowId: string;
  /** Member payouts applied to contributions in the same tx. */
  payouts: ReadonlyArray<{ contributionId: string; amountKobo: number }>;
  /** marketplace.pool.settled outbox event (committed in the same tx). */
  event: DomainEvent;
}

export interface CoopPoolRepository extends AsyncRepository<PoolListing, PoolCriteria> {
  /**
   * True when settleSplit persists marker + postings + state + outbox event
   * in one database transaction (PostgreSQL implementation).
   */
  readonly transactionalSplit?: boolean;

  listContributions(criteria: ContributionCriteria): Promise<PoolContribution[]>;
  addContribution(contribution: PoolContribution): Promise<PoolContribution>;
  updateContribution(
    id: string,
    patch: Partial<PoolContribution>
  ): Promise<PoolContribution>;

  /** The committed split marker for a pool, if settlement ever landed. */
  splitMarkerFor(poolId: string): Promise<PoolSplitMarker | undefined>;
  /**
   * Non-transactional claim (in-memory path): inserts the marker unless one
   * exists for the pool. Returns true when this call holds the claim.
   */
  claimSplitMarker(marker: PoolSplitMarker): Promise<boolean>;
  /** Releases an uncommitted claim after a failed posting (in-memory path). */
  releaseSplitMarker(poolId: string): Promise<void>;

  /**
   * PostgreSQL-only single-transaction settlement. Returns 'applied' when
   * this call committed the split, 'replay' when the marker already existed
   * (a previous settle committed — nothing is re-posted).
   */
  settleSplit?(input: CoopPoolSplitInput): Promise<'applied' | 'replay'>;
}

export function poolMatcher(criteria: PoolCriteria): (pool: PoolListing) => boolean {
  return (pool) =>
    (!criteria.cooperativeId || pool.cooperativeId === criteria.cooperativeId) &&
    (!criteria.listingId || pool.listingId === criteria.listingId) &&
    (!criteria.status || pool.status === criteria.status);
}

export function contributionMatcher(
  criteria: ContributionCriteria
): (contribution: PoolContribution) => boolean {
  return (contribution) =>
    (!criteria.poolId || contribution.poolId === criteria.poolId) &&
    (!criteria.memberUserId || contribution.memberUserId === criteria.memberUserId) &&
    (!criteria.status || contribution.status === criteria.status);
}

export class InMemoryCoopPoolRepository
  extends InMemoryRepository<PoolListing, PoolCriteria>
  implements CoopPoolRepository
{
  private readonly contributions = new Map<string, PoolContribution>();
  private readonly splitMarkers = new Map<string, PoolSplitMarker>();

  constructor(seed: readonly PoolListing[] = []) {
    super(seed, poolMatcher);
  }

  async listContributions(criteria: ContributionCriteria): Promise<PoolContribution[]> {
    return [...this.contributions.values()]
      .filter(contributionMatcher(criteria))
      .map((contribution) => structuredClone(contribution));
  }

  async addContribution(contribution: PoolContribution): Promise<PoolContribution> {
    // Mirror the (pool_id, member_user_id) UNIQUE index (23505 → 409).
    const duplicate = [...this.contributions.values()].some(
      (existing) =>
        existing.poolId === contribution.poolId &&
        existing.memberUserId === contribution.memberUserId
    );
    if (duplicate) {
      throw new ConflictException(
        `Member '${contribution.memberUserId}' already pledged to pool '${contribution.poolId}'`
      );
    }
    this.contributions.set(contribution.id, structuredClone(contribution));
    return contribution;
  }

  async updateContribution(
    id: string,
    patch: Partial<PoolContribution>
  ): Promise<PoolContribution> {
    const existing = this.contributions.get(id);
    if (!existing) {
      throw new NotFoundException(`Pool contribution '${id}' not found`);
    }
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.contributions.set(id, updated);
    return structuredClone(updated);
  }

  async splitMarkerFor(poolId: string): Promise<PoolSplitMarker | undefined> {
    const marker = this.splitMarkers.get(poolId);
    return marker ? structuredClone(marker) : undefined;
  }

  async claimSplitMarker(marker: PoolSplitMarker): Promise<boolean> {
    if (this.splitMarkers.has(marker.poolId)) {
      return false;
    }
    this.splitMarkers.set(marker.poolId, structuredClone(marker));
    return true;
  }

  async releaseSplitMarker(poolId: string): Promise<void> {
    this.splitMarkers.delete(poolId);
  }
}

export function createInMemoryCoopPoolRepository(
  seed: readonly PoolListing[] = []
): InMemoryCoopPoolRepository {
  return new InMemoryCoopPoolRepository(seed);
}
