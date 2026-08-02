/**
 * Meilisearch search driver (wave P1). The search module currently fans
 * out over the domain repositories (stub driver); this provider mirrors
 * that result contract so the module can swap to Meilisearch without
 * changing its public response shape. Self-hosted Meilisearch needs no
 * third-party credentials (MEILISEARCH_HOST; MEILISEARCH_API_KEY optional).
 */
import { httpJson, requireEnv } from './http.js';

/** Mirrors SearchResult in modules/search/search.service.ts. */
export interface SearchProviderResult {
  type: string;
  id: string;
  title: string;
  summary: string;
  score: number;
  state?: string;
}

/** A document indexed for cross-domain discovery. */
export interface SearchIndexDocument {
  id: string;
  type: string;
  title: string;
  summary: string;
  state?: string;
}

export interface SearchProviderQuery {
  types?: string[];
  state?: string;
  limit?: number;
}

/**
 * Search provider port (flag TBD in the matrix → SEARCH_DRIVER). The stub
 * implementation is the in-memory fan-out inside SearchService; this
 * interface is the seam the Meilisearch driver implements.
 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchProviderQuery): Promise<SearchProviderResult[]>;
  suggest(query: string, limit?: number): Promise<string[]>;
  indexDocuments(documents: SearchIndexDocument[]): Promise<void>;
  removeDocument(id: string): Promise<void>;
}

const DEFAULT_INDEX_UID = 'agric-platform';

interface MeiliSearchHit {
  id?: string;
  type?: string;
  title?: string;
  summary?: string;
  state?: string;
  _rankingScore?: number;
}

interface MeiliSearchResponse {
  hits?: MeiliSearchHit[];
}

export class MeilisearchSearchProvider implements SearchProvider {
  readonly name = 'meilisearch';

  constructor(
    private readonly host: string,
    private readonly apiKey?: string,
    private readonly indexUid: string = DEFAULT_INDEX_UID
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  private indexUrl(path = ''): string {
    return `${this.host.replace(/\/$/, '')}/indexes/${this.indexUid}${path}`;
  }

  async search(query: string, options: SearchProviderQuery = {}): Promise<SearchProviderResult[]> {
    const filters: string[] = [];
    if (options.types?.length) {
      filters.push(`type IN [${options.types.map((type) => `'${type}'`).join(', ')}]`);
    }
    if (options.state) {
      filters.push(`state = '${options.state}'`);
    }
    const response = await httpJson<MeiliSearchResponse>(this.name, this.indexUrl('/search'), {
      headers: this.headers(),
      body: {
        q: query,
        limit: options.limit ?? 20,
        ...(filters.length ? { filter: filters.join(' AND ') } : {}),
        showRankingScore: true
      }
    });
    return (response.hits ?? [])
      .filter((hit) => hit.id && hit.title)
      .map((hit) => ({
        type: hit.type ?? 'unknown',
        id: hit.id as string,
        title: hit.title as string,
        summary: hit.summary ?? '',
        score: hit._rankingScore ?? 0,
        state: hit.state
      }));
  }

  async suggest(query: string, limit = 5): Promise<string[]> {
    return (await this.search(query, { limit })).map((result) => result.title);
  }

  async indexDocuments(documents: SearchIndexDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await httpJson(this.name, this.indexUrl('/documents'), {
      headers: this.headers(),
      body: documents
    });
  }

  async removeDocument(id: string): Promise<void> {
    await httpJson(this.name, this.indexUrl(`/documents/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: this.headers()
    });
  }
}

/** Builds the live search provider; fails closed without MEILISEARCH_HOST. */
export function createSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  return new MeilisearchSearchProvider(
    requireEnv('search', env, ['MEILISEARCH_HOST']),
    env.MEILISEARCH_API_KEY,
    env.MEILISEARCH_INDEX
  );
}
