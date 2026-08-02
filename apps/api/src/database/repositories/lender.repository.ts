import type { Lender } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedLenders } from '../seed-data.js';

export interface LenderCriteria {
  active?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LenderRepository extends AsyncRepository<Lender, LenderCriteria> {}

export function lenderMatcher(criteria: LenderCriteria): (lender: Lender) => boolean {
  return (lender) => criteria.active === undefined || lender.isActive === criteria.active;
}

export class InMemoryLenderRepository
  extends InMemoryRepository<Lender, LenderCriteria>
  implements LenderRepository
{
  constructor(seed: readonly Lender[] = []) {
    super(seed, lenderMatcher);
  }
}

export function createInMemoryLenderRepository(): InMemoryLenderRepository {
  return new InMemoryLenderRepository(seedLenders);
}
