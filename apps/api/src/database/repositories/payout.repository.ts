import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { EscrowPayout } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface EscrowPayoutCriteria {
  escrowId?: string;
  orderId?: string;
  idempotencyKey?: string;
  status?: EscrowPayout['status'];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EscrowPayoutRepository extends AsyncRepository<EscrowPayout, EscrowPayoutCriteria> {}

export function escrowPayoutMatcher(criteria: EscrowPayoutCriteria): (payout: EscrowPayout) => boolean {
  return (payout) =>
    (!criteria.escrowId || payout.escrowId === criteria.escrowId) &&
    (!criteria.orderId || payout.orderId === criteria.orderId) &&
    (!criteria.idempotencyKey || payout.idempotencyKey === criteria.idempotencyKey) &&
    (!criteria.status || payout.status === criteria.status);
}

export class InMemoryEscrowPayoutRepository
  extends InMemoryRepository<EscrowPayout, EscrowPayoutCriteria>
  implements EscrowPayoutRepository
{
  constructor(seed: readonly EscrowPayout[] = []) {
    super(seed, escrowPayoutMatcher);
  }

  /**
   * Mirror the pg UNIQUE index on idempotency_key
   * (048 escrow_payouts_idempotency_key_uq → 23505 → ConflictException): a
   * twin create under the same key cannot persist a second row. The
   * check-and-set body deliberately contains NO await (same doctrine as
   * InMemoryRepository.updateExpected) so concurrent claims serialise in
   * one synchronous tick exactly like the index.
   */
  override async create(item: EscrowPayout): Promise<EscrowPayout> {
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === item.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    return super.create(item);
  }
}

export function createInMemoryEscrowPayoutRepository(): InMemoryEscrowPayoutRepository {
  return new InMemoryEscrowPayoutRepository();
}

/**
 * Stable payout-payload fingerprint for key-mismatch detection (mirrors the
 * Idempotency-Key interceptor's request-hash contract: same key + same body
 * replays, same key + different body is a 409).
 */
export function hashPayoutPayload(payout: {
  escrowId: string;
  orderId: string;
  kind: EscrowPayout['kind'];
  amountKobo: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        escrowId: payout.escrowId,
        orderId: payout.orderId,
        kind: payout.kind,
        amountKobo: payout.amountKobo
      })
    )
    .digest('hex');
}

/**
 * Claim lease (Stage 24, audit A4-3): a crashed claimant's 'in_progress'
 * attempt becomes re-claimable once the lease has expired. Ten minutes far
 * exceeds any in-request driver call; lease expiry exists for crash
 * recovery only, never for concurrent retries (a fresh claim rejects 409).
 */
export const PAYOUT_CLAIM_LEASE_MS = 10 * 60 * 1000;

export interface PayoutClaim {
  attempt: EscrowPayout;
  /** True only for the caller holding the claim — it alone may drive the payout. */
  claimed: boolean;
}

/**
 * Claims a payout attempt under its idempotency key (Stage 24, audit A4-3).
 * Exactly one caller holds the claim at a time and only that caller may
 * invoke the payout driver:
 *   - key unseen → insert directly in 'in_progress' and hold the claim;
 *     a twin create loses to the UNIQUE index (23505) and adopts the stored
 *     row through the same path as a pre-existing attempt;
 *   - key seen, SAME payload, status 'succeeded' → replay: return the stored
 *     attempt with claimed=false (never a second money movement);
 *   - key seen, SAME payload, status 'recorded'/'failed' (or an expired
 *     'in_progress' claim) → CAS to 'in_progress'; the CAS loser re-reads
 *     and either adopts a 'succeeded' twin or is rejected 409;
 *   - key seen with a fresh 'in_progress' claim → 409 (in progress — the
 *     claimant is still driving; retry after the lease expires);
 *   - key seen with a DIFFERENT payload → 409 Conflict, exactly like the
 *     Idempotency-Key interceptor's key-mismatch rule.
 */
export async function claimPayoutAttempt(
  repository: EscrowPayoutRepository,
  attempt: Omit<EscrowPayout, 'status' | 'claimedAt'>,
  now: Date = new Date()
): Promise<PayoutClaim> {
  const existing = await repository.findOne({ idempotencyKey: attempt.idempotencyKey });
  if (existing) {
    return claimExistingPayoutAttempt(repository, existing, attempt.payloadHash, now);
  }
  const nowIso = now.toISOString();
  try {
    const created = await repository.create({
      ...attempt,
      status: 'in_progress',
      claimedAt: nowIso,
      createdAt: attempt.createdAt,
      updatedAt: nowIso
    });
    return { attempt: created, claimed: true };
  } catch (error) {
    if (!(error instanceof ConflictException)) {
      throw error;
    }
    // Adopt-on-23505: a concurrent twin created the row first. Re-read and
    // converge through the standard claim path instead of surfacing a raw
    // conflict mid-rail.
    const twin = await repository.findOne({ idempotencyKey: attempt.idempotencyKey });
    if (!twin) {
      throw error; // the row vanished between create and re-read — surface it
    }
    return claimExistingPayoutAttempt(repository, twin, attempt.payloadHash, now);
  }
}

async function claimExistingPayoutAttempt(
  repository: EscrowPayoutRepository,
  existing: EscrowPayout,
  payloadHash: string,
  now: Date
): Promise<PayoutClaim> {
  if (existing.payloadHash !== payloadHash) {
    throw new ConflictException(
      `Idempotency key '${existing.idempotencyKey}' was already used for a different payout ` +
        `(stored ${existing.kind} ${existing.amountKobo} kobo on escrow ${existing.escrowId})`
    );
  }
  if (existing.status === 'succeeded') {
    return { attempt: existing, claimed: false };
  }
  if (existing.status === 'in_progress') {
    const claimedAtMs = existing.claimedAt ? Date.parse(existing.claimedAt) : 0;
    if (now.getTime() - claimedAtMs < PAYOUT_CLAIM_LEASE_MS) {
      throw new ConflictException(
        `Payout attempt '${existing.idempotencyKey}' is already in progress ` +
          `(claimed at ${existing.claimedAt}); a concurrent claimant holds the lease`
      );
    }
    // Lease expired: the claimant crashed mid-drive; fall through to re-claim.
  }
  const nowIso = now.toISOString();
  try {
    const claimed = await repository.updateExpected(
      existing.id,
      { status: 'in_progress', claimedAt: nowIso, updatedAt: nowIso },
      existing.status === 'in_progress'
        ? // Re-claim of an expired lease: also pins claimedAt so a twin that
          // re-claimed first (changing claimedAt) loses this CAS.
          { status: 'in_progress', claimedAt: existing.claimedAt }
        : { status: existing.status }
    );
    return { attempt: claimed, claimed: true };
  } catch (error) {
    if (!(error instanceof ConflictException)) {
      throw error;
    }
    const current = await repository.findById(existing.id);
    if (current?.status === 'succeeded') {
      return { attempt: current, claimed: false };
    }
    throw new ConflictException(
      `Payout attempt '${existing.idempotencyKey}' is already in progress; ` +
        'a concurrent claimant won the claim race'
    );
  }
}

/**
 * Finalizes a held claim (Stage 24, audit A4-3): the guarded write matches
 * on BOTH the 'in_progress' status and this claimant's lease start, so
 *   - only the claim holder can finalize;
 *   - 'succeeded' can never regress to 'failed' — a stale failure write
 *     loses the CAS, re-reads the succeeded row and adopts it (the payout
 *     already happened; the escrow may proceed to its terminal state);
 *   - a claim that changed hands mid-finalize (lease expiry re-claim)
 *     surfaces 409 and the transition must be retried — the retry converges
 *     through the deterministic idempotency key.
 */
export async function finalizePayoutAttempt(
  repository: EscrowPayoutRepository,
  claim: EscrowPayout,
  outcome:
    | { status: 'succeeded'; providerReference?: string }
    | { status: 'failed'; failureReason: string }
): Promise<EscrowPayout> {
  const updatedAt = new Date().toISOString();
  const patch: Partial<EscrowPayout> =
    outcome.status === 'succeeded'
      ? { status: 'succeeded', providerReference: outcome.providerReference, updatedAt }
      : { status: 'failed', failureReason: outcome.failureReason, updatedAt };
  try {
    return await repository.updateExpected(
      claim.id,
      patch,
      { status: 'in_progress', claimedAt: claim.claimedAt }
    );
  } catch (error) {
    if (!(error instanceof ConflictException)) {
      throw error;
    }
    const current = await repository.findById(claim.id);
    if (current?.status === 'succeeded') {
      return current; // never regress a succeeded payout — adopt the twin's win
    }
    throw new ConflictException(
      `Payout attempt '${claim.idempotencyKey}' changed hands while finalizing; ` +
        'retry the escrow transition to converge'
    );
  }
}
