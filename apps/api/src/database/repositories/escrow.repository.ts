import type { EscrowRecord, EscrowStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface EscrowCriteria {
  orderId?: string;
  status?: EscrowStatus;
  /** Deposit-evidence reference (Stage 24, audit A1-2 reference-reuse check). */
  depositReference?: string;
}

export interface EscrowRepository extends AsyncRepository<EscrowRecord, EscrowCriteria> {
  /**
   * WP-G12 batch selection for the escrow-expiry sweeper: non-terminal
   * records (held/releasing/refunding) whose heldUntil deadline has passed,
   * oldest first, capped at `limit`. The pg implementation selects with
   * FOR UPDATE SKIP LOCKED so concurrent sweepers never block on rows locked
   * by an in-flight transition; state re-verification on write stays with
   * the CAS guard (updateExpected), so a double-run is a no-op.
   */
  findExpiredForSweep?(nowIso: string, limit: number): Promise<EscrowRecord[]>;
}

/** Non-terminal escrow statuses the expiry sweeper may act on. */
export const SWEEPABLE_ESCROW_STATUSES: readonly EscrowStatus[] = [
  'held',
  'releasing',
  'refunding'
];

export function escrowMatcher(criteria: EscrowCriteria): (record: EscrowRecord) => boolean {
  return (record) =>
    (!criteria.orderId || record.orderId === criteria.orderId) &&
    (!criteria.status || record.status === criteria.status) &&
    (!criteria.depositReference || record.depositReference === criteria.depositReference);
}

export class InMemoryEscrowRepository
  extends InMemoryRepository<EscrowRecord, EscrowCriteria>
  implements EscrowRepository
{
  constructor(seed: readonly EscrowRecord[] = []) {
    super(seed, escrowMatcher);
  }

  /** Single-process equivalent of the pg FOR UPDATE SKIP LOCKED batch. */
  async findExpiredForSweep(nowIso: string, limit: number): Promise<EscrowRecord[]> {
    return (await this.all())
      .filter(
        (record) =>
          SWEEPABLE_ESCROW_STATUSES.includes(record.status) &&
          record.heldUntil !== undefined &&
          record.heldUntil <= nowIso
      )
      .sort((a, b) => (a.heldUntil ?? '').localeCompare(b.heldUntil ?? ''))
      .slice(0, Math.max(0, limit));
  }
}

export function createInMemoryEscrowRepository(): InMemoryEscrowRepository {
  return new InMemoryEscrowRepository();
}
