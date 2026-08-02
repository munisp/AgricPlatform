import type { TrendingQuery } from '@agric-platform/shared';
import type { SearchResult, SearchResultType } from './search.service.js';

/**
 * Search provider port (M16). The in-process fan-out implementation in
 * SearchService is bound to this token today; the Meilisearch driver
 * (integrations wave) slots in behind the same contract without controller
 * changes.
 */
export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');

export interface SearchProvider {
  search(
    query: string,
    types?: SearchResultType[],
    state?: string,
    limit?: number
  ): Promise<SearchResult[]>;
  suggest(query: string, limit?: number): Promise<string[]>;
  trending(options?: { now?: Date; limit?: number }): Promise<TrendingQuery[]>;
  related(type: SearchResultType, id: string, limit?: number): Promise<SearchResult[]>;
}
