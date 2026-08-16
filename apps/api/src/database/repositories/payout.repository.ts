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
 * Records a payout attempt under its idempotency key (Stage 23).
 * Replay contract:
 *   - key unseen → insert and return the new attempt (status 'recorded');
 *   - key seen with the SAME payload → return the stored attempt unchanged
 *     (idempotent replay of a retry — never a second money movement);
 *   - key seen with a DIFFERENT payload → 409 Conflict, exactly like the
 *     Idempotency-Key interceptor's key-mismatch rule.
 */
export async function recordPayoutAttempt(
  repository: EscrowPayoutRepository,
  attempt: EscrowPayout
): Promise<EscrowPayout> {
  const existing = await repository.findOne({ idempotencyKey: attempt.idempotencyKey });
  if (existing) {
    if (existing.payloadHash !== attempt.payloadHash) {
      throw new ConflictException(
        `Idempotency key '${attempt.idempotencyKey}' was already used for a different payout ` +
          `(stored ${existing.kind} ${existing.amountKobo} kobo on escrow ${existing.escrowId})`
      );
    }
    return existing;
  }
  return repository.create(attempt);
}
