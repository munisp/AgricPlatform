import type { ConsentRecord } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedConsents } from '../seed-data.js';

export interface ConsentCriteria {
  userId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ConsentRepository extends AsyncRepository<ConsentRecord, ConsentCriteria> {}

export function consentMatcher(criteria: ConsentCriteria): (consent: ConsentRecord) => boolean {
  return (consent) => !criteria.userId || consent.userId === criteria.userId;
}

export class InMemoryConsentRepository
  extends InMemoryRepository<ConsentRecord, ConsentCriteria>
  implements ConsentRepository
{
  constructor(seed: readonly ConsentRecord[] = []) {
    super(seed, consentMatcher);
  }
}

export function createInMemoryConsentRepository(): InMemoryConsentRepository {
  return new InMemoryConsentRepository(seedConsents);
}
