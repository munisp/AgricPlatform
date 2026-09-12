import type { TrendingQuery } from '@agric-platform/shared';
import type { SearchDriverStatus } from '../integrations/drivers/search.drivers.js';
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
  /**
   * WP-G10: optional driver status accessor. Only the live drivers
   * (OpenSearch, Meilisearch) implement it; the in-process SearchService
   * has no external backend and deliberately does not.
   */
  status?(): Promise<SearchDriverStatus>;
}
