import type { EscrowRecord, EscrowStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface EscrowCriteria {
  orderId?: string;
  status?: EscrowStatus;
  /** Deposit-evidence reference (Stage 24, audit A1-2 reference-reuse check). */
  depositReference?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EscrowRepository extends AsyncRepository<EscrowRecord, EscrowCriteria> {}

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
}

export function createInMemoryEscrowRepository(): InMemoryEscrowRepository {
  return new InMemoryEscrowRepository();
}
