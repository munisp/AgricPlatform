import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Deceased/succession (V-09, migration 086). A next-of-kin claim against a
 * deceased user's estate. DISTINCT from DSAR erasure: the deceased identity
 * row is NEVER anonymised (estate linkage must survive for the claim), the
 * account is frozen via the `deceased` account status instead.
 */
export type SuccessionClaimStatus = 'pending' | 'approved' | 'rejected';

export interface SuccessionClaim {
  id: string;
  /** The deceased account whose estate is claimed. */
  deceasedUserId: string;
  /** Platform account of the heir (must exist at approval time). */
  heirUserId?: string;
  claimantName: string;
  claimantPhone?: string;
  relationship: string;
  /** Reference to the death/succession evidence (death certificate etc.). */
  evidenceRef: string;
  status: SuccessionClaimStatus;
  filedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
}

export interface SuccessionClaimCriteria {
  deceasedUserId?: string;
  heirUserId?: string;
  status?: SuccessionClaimStatus;
}

export interface SuccessionClaimRepository
  extends AsyncRepository<SuccessionClaim, SuccessionClaimCriteria> {}

export function successionClaimMatcher(
  criteria: SuccessionClaimCriteria
): (claim: SuccessionClaim) => boolean {
  return (claim) =>
    (!criteria.deceasedUserId || claim.deceasedUserId === criteria.deceasedUserId) &&
    (!criteria.heirUserId || claim.heirUserId === criteria.heirUserId) &&
    (!criteria.status || claim.status === criteria.status);
}

export class InMemorySuccessionClaimRepository
  extends InMemoryRepository<SuccessionClaim, SuccessionClaimCriteria>
  implements SuccessionClaimRepository
{
  constructor(seed: readonly SuccessionClaim[] = []) {
    super(seed, successionClaimMatcher);
  }
}

export function createInMemorySuccessionClaimRepository(): InMemorySuccessionClaimRepository {
  return new InMemorySuccessionClaimRepository();
}
