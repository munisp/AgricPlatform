import { BadRequestException } from '@nestjs/common';
import type { LedgerPosting } from '@agric-platform/shared';

/**
 * Coop Pool & Split (Stage 27 Batch 1, Innovation 2) — pure domain logic.
 *
 * A cooperative pools member harvest into one graded bulk listing; on escrow
 * release the proceeds split to member ledger sub-accounts by shares locked
 * in basis points. This module holds the deterministic math (no I/O) so the
 * invariants are unit-testable in isolation:
 *   - Σ share_bps over a locked pool === 10000 (largest-remainder rounding)
 *   - Σ member credit amounts === escrow release amount, integer kobo,
 *     balanced by construction (the clearing debit equals the credit sum)
 *   - every member share is ≥ 1 kobo (a zero-kobo credit is rejected, never
 *     silently posted — a member whose pledge rounds to nothing must be
 *     resolved by the cooperative before settlement)
 */

export const POOL_STATUSES = ['draft', 'open', 'locked', 'settled'] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

export const POOL_CONTRIBUTION_STATUSES = ['pledged', 'delivered', 'rejected', 'paid'] as const;
export type PoolContributionStatus = (typeof POOL_CONTRIBUTION_STATUSES)[number];

export interface PoolListing {
  id: string;
  /** Cooperative (chapter) id; the seller identity on the locked listing. */
  cooperativeId: string;
  /** Marketplace listing created at lock; undefined while open. */
  listingId?: string;
  title: string;
  crop?: string;
  /** Integer kobo unit price (money never floats). */
  unitPriceKobo: number;
  location?: { state: string; lga: string; ward?: string };
  minPoolQtyKg: number;
  /** Σ contribution qty at lock; 0 while open. */
  totalQtyKg: number;
  status: PoolStatus;
  lockedAt?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PoolContribution {
  id: string;
  poolId: string;
  memberUserId: string;
  qtyKg: number;
  qualityGrade: string;
  /** Share in basis points (1..10000); undefined until lock. */
  shareBps?: number;
  /** Ledger account natural key credited at settlement. */
  ledgerAccountCode: string;
  /** Integer kobo credited to the member; undefined until settlement. */
  amountKobo?: number;
  status: PoolContributionStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Exactly-once settlement marker (marketplace.pool_split_markers): a
 * committed marker row proves the split journal committed (same
 * transaction), so a replay can no-op without re-posting.
 */
export interface PoolSplitMarker {
  poolId: string;
  escrowId: string;
  ledgerEntryId: string;
  totalKobo: number;
  memberCount: number;
  idempotencyKey: string;
  createdAt: string;
}

/** Feature flag (default OFF; fail-closed 404/absent until enabled). */
export const COOP_POOL_FLAG = 'coop-pool-listings';

/** Deterministic per-pool split key (ledger idempotency + marker). */
export function poolSplitIdempotencyKey(poolId: string): string {
  return `coop-pool-split:${poolId}`;
}

/** Clearing account holding the released escrow proceeds of one pool. */
export function poolClearingAccountCode(poolId: string): string {
  return `coop_pool:${poolId}:escrow_clearing`;
}

/** Member ledger sub-account credited with that member's split share. */
export function memberPoolAccountCode(memberUserId: string): string {
  return `member:${memberUserId}:coop_pool`;
}

/**
 * Largest-remainder allocation of `total` whole units across `weights`.
 * Deterministic: remainders are ranked descending, ties break by id
 * ascending, so every replay produces the identical allocation. The result
 * always sums to exactly `total`.
 */
export function largestRemainderAllocation(
  items: ReadonlyArray<{ id: string; weight: number }>,
  total: number
): Map<string, number> {
  if (items.length === 0) {
    throw new BadRequestException('Cannot allocate over an empty item set');
  }
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new BadRequestException(`Allocation total must be a positive integer (got ${total})`);
  }
  let weightSum = 0;
  for (const item of items) {
    if (!Number.isFinite(item.weight) || item.weight <= 0) {
      throw new BadRequestException(
        `Allocation weight for '${item.id}' must be positive (got ${item.weight})`
      );
    }
    weightSum += item.weight;
  }
  const shares = items.map((item) => {
    const exact = (item.weight * total) / weightSum;
    const floor = Math.floor(exact);
    return { id: item.id, floor, remainder: exact - floor };
  });
  let assigned = shares.reduce((sum, share) => sum + share.floor, 0);
  // Distribute the leftover units one at a time to the largest remainders.
  const ranked = [...shares].sort(
    (a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : 1)
  );
  let cursor = 0;
  while (assigned < total) {
    ranked[cursor % ranked.length].floor += 1;
    assigned += 1;
    cursor += 1;
  }
  return new Map(shares.map((share) => [share.id, share.floor]));
}

/**
 * Lock-time share computation: each contribution's share_bps is its qty
 * weight of 10000 bps, largest-remainder rounded so Σ share_bps === 10000.
 */
export function computeSharesBps(
  contributions: ReadonlyArray<{ id: string; qtyKg: number }>
): Map<string, number> {
  const shares = largestRemainderAllocation(
    contributions.map((contribution) => ({ id: contribution.id, weight: contribution.qtyKg })),
    10000
  );
  for (const [id, bps] of shares) {
    if (bps < 1 || bps > 10000) {
      // Unreachable by construction; guarded so a future refactor fails loud.
      throw new BadRequestException(`Computed share for contribution '${id}' out of bounds (${bps} bps)`);
    }
  }
  return shares;
}

export interface SplitAllocation {
  contributionId: string;
  memberUserId: string;
  ledgerAccountCode: string;
  shareBps: number;
  amountKobo: number;
}

/**
 * Settlement-time split: integer-kobo amounts per member, largest-remainder
 * on share_bps so Σ amountKobo === totalKobo (the escrow release amount).
 * Every member must receive ≥ 1 kobo; otherwise settlement is refused
 * (409-class BadRequest) rather than posting a zero-kobo credit.
 */
export function splitPoolProceeds(
  totalKobo: number,
  contributions: ReadonlyArray<
    Pick<PoolContribution, 'id' | 'memberUserId' | 'ledgerAccountCode' | 'shareBps'>
  >
): SplitAllocation[] {
  const amounts = largestRemainderAllocation(
    contributions.map((contribution) => ({
      id: contribution.id,
      weight: contribution.shareBps ?? 0
    })),
    totalKobo
  );
  const allocations: SplitAllocation[] = contributions.map((contribution) => ({
    contributionId: contribution.id,
    memberUserId: contribution.memberUserId,
    ledgerAccountCode: contribution.ledgerAccountCode,
    shareBps: contribution.shareBps ?? 0,
    amountKobo: amounts.get(contribution.id) ?? 0
  }));
  for (const allocation of allocations) {
    if (allocation.amountKobo < 1) {
      throw new BadRequestException(
        `Pool split of ${totalKobo} kobo leaves member '${allocation.memberUserId}' with 0 kobo; ` +
          'refusing to post a zero-kobo credit — adjust the pool composition before settlement'
      );
    }
  }
  const sum = allocations.reduce((acc, allocation) => acc + allocation.amountKobo, 0);
  if (sum !== totalKobo) {
    // Unreachable by construction; the DB re-checks this invariant in the
    // settlement transaction as well (defense in depth).
    throw new BadRequestException(
      `Unbalanced pool split: member credits ${sum} kobo != escrow release ${totalKobo} kobo`
    );
  }
  return allocations;
}

/**
 * Builds the balanced double-entry posting set for a split: DR the pool
 * escrow-clearing account (funds due from the payout rail), CR each member
 * sub-account. Debits === credits === escrow release amount by construction;
 * LedgerService / the pg settlement transaction re-assert the invariant.
 */
export function buildSplitPostings(
  poolId: string,
  totalKobo: number,
  allocations: readonly SplitAllocation[]
): LedgerPosting[] {
  return [
    {
      accountCode: poolClearingAccountCode(poolId),
      direction: 'debit',
      amountKobo: totalKobo
    },
    ...allocations.map(
      (allocation): LedgerPosting => ({
        accountCode: allocation.ledgerAccountCode,
        direction: 'credit',
        amountKobo: allocation.amountKobo
      })
    )
  ];
}
