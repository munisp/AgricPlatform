import type { SearchQueryEvent } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface SearchQueryCriteria {
  /** ISO-8601 lower bound on occurredAt (inclusive). */
  since?: string;
}

export type SearchQueryRepository = AsyncRepository<SearchQueryEvent, SearchQueryCriteria>;

export function searchQueryMatcher(criteria: SearchQueryCriteria): (event: SearchQueryEvent) => boolean {
  return (event) => !criteria.since || event.occurredAt >= criteria.since;
}

export class InMemorySearchQueryRepository
  extends InMemoryRepository<SearchQueryEvent, SearchQueryCriteria>
  implements SearchQueryRepository
{
  constructor(seed: readonly SearchQueryEvent[] = []) {
    super(seed, searchQueryMatcher);
  }
}

export function createInMemorySearchQueryRepository(): InMemorySearchQueryRepository {
  return new InMemorySearchQueryRepository();
}
