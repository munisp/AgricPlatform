import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Erasure legal-hold sign-off (V-25, migration 089). NDPA inventory
 * categories under legal hold (orders/escrow/ledger/consent/audit) keep data
 * past an erasure request ONLY with a per-category DPO sign-off — recorded
 * here instead of silently keeping PII.
 */
export interface ErasureHold {
  id: string;
  userId: string;
  /** NDPA inventory category key, e.g. 'finance_ledger_loans'. */
  category: string;
  reason: string;
  signedOffBy: string;
  signedOffAt: string;
}

export interface ErasureHoldCriteria {
  userId?: string;
  category?: string;
}

export interface ErasureHoldRepository extends AsyncRepository<ErasureHold, ErasureHoldCriteria> {}

export function erasureHoldMatcher(criteria: ErasureHoldCriteria): (hold: ErasureHold) => boolean {
  return (hold) =>
    (!criteria.userId || hold.userId === criteria.userId) &&
    (!criteria.category || hold.category === criteria.category);
}

export class InMemoryErasureHoldRepository
  extends InMemoryRepository<ErasureHold, ErasureHoldCriteria>
  implements ErasureHoldRepository
{
  constructor(seed: readonly ErasureHold[] = []) {
    super(seed, erasureHoldMatcher);
  }
}

export function createInMemoryErasureHoldRepository(): InMemoryErasureHoldRepository {
  return new InMemoryErasureHoldRepository();
}
