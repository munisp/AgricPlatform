/**
 * OpenSearch search driver (wave FABRIC): a live SearchProvider behind the
 * search module's existing port (modules/search/search.provider.ts). The
 * stub is the current in-process SearchService fan-out — returned
 * unchanged whenever SEARCH_DRIVER is anything other than 'opensearch'.
 * SEARCH_DRIVER=opensearch REQUIRES OPENSEARCH_NODE and fails closed: the
 * factory throws ProviderConfigError at boot when the node URL is absent,
 * and query failures raise ProviderHttpError/ProviderRequestError —
 * never a silent fallback to the in-process search.
 *
 * Query-path only: trending and related stay delegated to the in-process
 * fallback (they are repository-computed, not index-backed). Indexing is
 * an offline concern — the index mapping lives in
 * infra/opensearch/agric-platform-index.json with the reindex runbook in
 * docs/integration-fabric.md.
 */
import type { SearchProvider } from '../../search/search.provider.js';
import type { SearchResult, SearchResultType } from '../../search/search.service.js';
import type { TrendingQuery } from '@agric-platform/shared';
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from './http.js';

/** Default OpenSearch index for cross-domain discovery documents. */
export const OPENSEARCH_DEFAULT_INDEX = 'agric-platform';

const KNOWN_TYPES: readonly SearchResultType[] = [
  'course',
  'opportunity',
  'listing',
  'advisory',
  'chapter',
  'topic'
];

export interface OpenSearchHit {
  _id?: string;
  _score?: number | null;
  _source?: {
    type?: string;
    title?: string;
    summary?: string;
    state?: string;
  };
}

export interface OpenSearchSearchResponse {
  hits?: { hits?: OpenSearchHit[] };
}

/** Minimal client surface (@opensearch-project/opensearch Client subset). */
export interface OpenSearchClientLike {
  search(params: { index: string; body: unknown }): Promise<unknown>;
}

export type OpenSearchClientFactory = () => Promise<OpenSearchClientLike>;

async function defaultClientFactory(
  node: string,
  env: NodeJS.ProcessEnv
): Promise<OpenSearchClientLike> {
  const { Client } = await import('@opensearch-project/opensearch');
  const username = env.OPENSEARCH_USERNAME;
  return new Client({
    node,
    ...(username
      ? { auth: { username, password: env.OPENSEARCH_PASSWORD ?? '' } }
      : {}),
    ssl: { rejectUnauthorized: env.OPENSEARCH_TLS_REJECT_UNAUTHORIZED !== 'false' }
  }) as unknown as OpenSearchClientLike;
}

/** Unwraps the client's { body } envelope (ApiResponse) when present. */
function unwrapBody(raw: unknown): OpenSearchSearchResponse {
  if (raw && typeof raw === 'object' && 'body' in raw) {
    return (raw as { body: OpenSearchSearchResponse }).body;
  }
  return raw as OpenSearchSearchResponse;
}

/** Maps SDK errors onto the shared provider error taxonomy (fail closed). */
function mapClientError(error: unknown): never {
  const statusCode =
    (error as { statusCode?: number; meta?: { statusCode?: number } })?.statusCode ??
    (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
  if (typeof statusCode === 'number') {
    throw new ProviderHttpError('opensearch', statusCode, (error as Error)?.message ?? '');
  }
  throw new ProviderRequestError('opensearch', 'network', error);
}

/**
 * Live OpenSearch provider. Query path (search + suggest) hits the
 * configured index; trending + related delegate to the in-process fallback
 * because they are computed from repository signals, not the index.
 */
export class OpenSearchSearchProvider implements SearchProvider {
  readonly name = 'opensearch';

  private client?: OpenSearchClientLike;

  constructor(
    private readonly options: {
      clientFactory: OpenSearchClientFactory;
      fallback: SearchProvider;
      index?: string;
    }
  ) {}

  get index(): string {
    return this.options.index?.trim() || OPENSEARCH_DEFAULT_INDEX;
  }

  /** The fallback provider trending/related delegate to. */
  get fallback(): SearchProvider {
    return this.options.fallback;
  }

  async search(
    query: string,
    types?: SearchResultType[],
    state?: string,
    limit?: number
  ): Promise<SearchResult[]> {
    const filter: unknown[] = [];
    if (types && types.length > 0) {
      filter.push({ terms: { type: types } });
    }
    if (state) {
      filter.push({ term: { state } });
    }
    const body = {
      size: limit ?? 20,
      query: {
        bool: {
          must: [{ multi_match: { query, fields: ['title^2', 'summary'] } }],
          ...(filter.length > 0 ? { filter } : {})
        }
      }
    };
    const response = await this.searchRaw(body);
    return (response.hits?.hits ?? [])
      .map((hit) => this.mapHit(hit))
      .filter((hit): hit is SearchResult => hit !== undefined);
  }

  async suggest(query: string, limit = 10): Promise<string[]> {
    const body = {
      size: limit,
      _source: ['title'],
      query: { match_phrase_prefix: { title: query } }
    };
    const response = await this.searchRaw(body);
    const titles = (response.hits?.hits ?? [])
      .map((hit) => hit._source?.title)
      .filter((title): title is string => typeof title === 'string' && title.length > 0);
    return [...new Set(titles)].slice(0, limit);
  }

  /** Trending is repository-computed (query-log signals) — not index-backed. */
  trending(options?: { now?: Date; limit?: number }): Promise<TrendingQuery[]> {
    return this.options.fallback.trending(options);
  }

  /** Related lookups fan out over domain repositories — not index-backed. */
  related(type: SearchResultType, id: string, limit?: number): Promise<SearchResult[]> {
    return this.options.fallback.related(type, id, limit);
  }

  private mapHit(hit: OpenSearchHit): SearchResult | undefined {
    const source = hit._source ?? {};
    const type = source.type as SearchResultType | undefined;
    if (!type || !KNOWN_TYPES.includes(type) || !source.title) {
      return undefined;
    }
    return {
      type,
      id: hit._id ?? '',
      title: source.title,
      summary: source.summary ?? '',
      score: hit._score ?? 0,
      ...(source.state ? { state: source.state } : {})
    };
  }

  private async searchRaw(body: unknown): Promise<OpenSearchSearchResponse> {
    try {
      const client = await this.ensureClient();
      return unwrapBody(await client.search({ index: this.index, body }));
    } catch (error) {
      if (error instanceof ProviderHttpError || error instanceof ProviderRequestError) {
        throw error;
      }
      mapClientError(error);
    }
  }

  private async ensureClient(): Promise<OpenSearchClientLike> {
    if (!this.client) {
      this.client = await this.options.clientFactory();
    }
    return this.client;
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Selects the search provider for the module query path. Default (stub,
 * meilisearch flag, or unset) returns the existing in-process SearchService
 * unchanged. SEARCH_DRIVER=opensearch requires OPENSEARCH_NODE and fails
 * closed with ProviderConfigError otherwise — boot aborts rather than
 * silently running the in-process search when the operator asked for
 * OpenSearch.
 */
export function createOpenSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
  fallback: SearchProvider
): SearchProvider {
  const flag = (env.SEARCH_DRIVER ?? '').toLowerCase();
  if (flag === 'opensearch') {
    const node = requireEnv('opensearch', env, ['OPENSEARCH_NODE']);
    return new OpenSearchSearchProvider({
      clientFactory: () => defaultClientFactory(node, env),
      fallback,
      index: env.OPENSEARCH_INDEX
    });
  }
  return fallback;
}
