import type { AdvisoryItem, ApiListResponse } from '@agric-platform/shared';
import { seedAdvisory } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface AdvisoryCriteria {
  kind?: AdvisoryItem['kind'];
  state?: string;
  crop?: string;
}

export interface AdvisoryRepository extends AsyncRepository<AdvisoryItem, AdvisoryCriteria> {
  searchPage(
    criteria: AdvisoryCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<AdvisoryItem>>;
}

export function advisoryMatcher(criteria: AdvisoryCriteria): (item: AdvisoryItem) => boolean {
  return (item) =>
    (!criteria.kind || item.kind === criteria.kind) &&
    (!criteria.state || item.state === criteria.state) &&
    (!criteria.crop || item.crop === criteria.crop);
}

export class InMemoryAdvisoryRepository
  extends InMemoryRepository<AdvisoryItem, AdvisoryCriteria>
  implements AdvisoryRepository
{
  constructor(seed: readonly AdvisoryItem[] = []) {
    super(seed, advisoryMatcher);
  }
}

export function createInMemoryAdvisoryRepository(): InMemoryAdvisoryRepository {
  return new InMemoryAdvisoryRepository(seedAdvisory);
}
