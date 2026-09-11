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
 * Stage 27 (WP-G10 telemetry gaps): the query path now has the platform's
 * standard hardening — an OPENSEARCH_TIMEOUT_MS request timeout (default
 * 5000, AbortController plus a race guard so the timeout fires even when a
 * client ignores the signal), the standard call-time circuit breaker (3
 * consecutive failures open the circuit for 30s, then a half-open probe),
 * and a status() accessor exposing breaker state, last error class and
 * last success timestamp for the readiness registry. Callers map
 * ProviderHttpError/ProviderRequestError to 503 ServiceUnavailable —
 * never 500 (see modules/search/search.controller.ts).
 *
 * Query-path only: trending and related stay delegated to the in-process
 * fallback (they are repository-computed, not index-backed). Indexing is
 * an offline concern — the index mapping lives in
 * infra/opensearch/agric-platform-index.json with the reindex runbook in
 * docs/integration-fabric.md.
 */
import { TelemetryService } from '../../../common/telemetry/telemetry.service.js';
import type { SearchProvider } from '../../search/search.provider.js';
import type { SearchResult, SearchResultType } from '../../search/search.service.js';
import type { TrendingQuery } from '@agric-platform/shared';
import {
  circuitBreakerState,
  DriverHealthTracker,
  type DriverHealthFields
} from './driver-health.js';
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from './http.js';
import {
  createSearchProvider,
  type SearchDriverStatus,
  type SearchProvider as MeilisearchClient
} from './search.drivers.js';

/** Default OpenSearch index for cross-domain discovery documents. */
export const OPENSEARCH_DEFAULT_INDEX = 'agric-platform';
/** Default request timeout (OPENSEARCH_TIMEOUT_MS override). */
export const OPENSEARCH_DEFAULT_TIMEOUT_MS = 5000;
/** Number of consecutive failures before the circuit opens. */
export const OPENSEARCH_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the half-open probe is allowed. */
export const OPENSEARCH_CIRCUIT_COOLDOWN_MS = 30_000;

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

/**
 * Minimal client surface (@opensearch-project/opensearch Client subset).
 * The optional transport options carry the AbortSignal — the real client
 * honours it; the race guard in searchRaw covers clients that do not.
 */
export interface OpenSearchClientLike {
  search(
    params: { index: string; body: unknown },
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export type OpenSearchClientFactory = () => Promise<OpenSearchClientLike>;

async function defaultClientFactory(
  node: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<OpenSearchClientLike> {
  const { Client } = await import('@opensearch-project/opensearch');
  const username = env.OPENSEARCH_USERNAME;
  return new Client({
    node,
    ...(username
      ? { auth: { username, password: env.OPENSEARCH_PASSWORD ?? '' } }
      : {}),
    requestTimeout: timeoutMs,
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
function toProviderError(error: unknown): ProviderHttpError | ProviderRequestError {
  const statusCode =
    (error as { statusCode?: number; meta?: { statusCode?: number } })?.statusCode ??
    (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
  if (typeof statusCode === 'number') {
    return new ProviderHttpError('opensearch', statusCode, (error as Error)?.message ?? '');
  }
  return new ProviderRequestError('opensearch', 'network', error);
}

/** Parses OPENSEARCH_TIMEOUT_MS; falls back to the default on junk input. */
export function parseOpenSearchTimeoutMs(value: string | undefined): number {
  if (!value) {
    return OPENSEARCH_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : OPENSEARCH_DEFAULT_TIMEOUT_MS;
}

/** Status report for the readiness registry (WP-G10). */
export interface OpenSearchDriverStatus extends DriverHealthFields {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

/**
 * Live OpenSearch provider. Query path (search + suggest) hits the
 * configured index; trending + related delegate to the in-process fallback
 * because they are computed from repository signals, not the index.
 */
export class OpenSearchSearchProvider implements SearchProvider {
  readonly name = 'opensearch';

  private client?: OpenSearchClientLike;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly tracker = new DriverHealthTracker();
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly options: {
      clientFactory: OpenSearchClientFactory;
      fallback: SearchProvider;
      index?: string;
      timeoutMs?: number;
      telemetry?: TelemetryService;
    }
  ) {
    // No-op-safe fallback when built outside Nest DI (tests): with the SDK
    // disabled every TelemetryService helper is a near-free no-op.
    this.telemetry = options.telemetry ?? new TelemetryService();
  }

  get index(): string {
    return this.options.index?.trim() || OPENSEARCH_DEFAULT_INDEX;
  }

  /** Request timeout in ms (OPENSEARCH_TIMEOUT_MS, default 5000). */
  get timeoutMs(): number {
    return this.options.timeoutMs && this.options.timeoutMs > 0
      ? this.options.timeoutMs
      : OPENSEARCH_DEFAULT_TIMEOUT_MS;
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

  /**
   * WP-G10 status accessor: driver name/configured state, circuit-breaker
   * state, last error class and last success timestamp. Never probes the
   * cluster — reachability is verified at call time (fail closed).
   */
  status(): Promise<OpenSearchDriverStatus> {
    return Promise.resolve({
      configured: true,
      healthy: this.client !== undefined && !this.circuitOpen,
      circuitBreaker: circuitBreakerState(
        this.consecutiveFailures,
        OPENSEARCH_CIRCUIT_THRESHOLD,
        this.circuitOpenUntil
      ),
      lastErrorClass: this.tracker.lastErrorClass,
      lastSuccessAt: this.tracker.lastSuccessAt,
      detail: this.client
        ? this.circuitOpen
          ? `OpenSearch client created but circuit open after ${this.consecutiveFailures} consecutive failures (index ${this.index}).`
          : `OpenSearch client created for index ${this.index} (timeout ${this.timeoutMs}ms).`
        : `OpenSearch driver selected (index ${this.index}, timeout ${this.timeoutMs}ms); client connects on first query.`
    });
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= OPENSEARCH_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
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
    // Stage 27 (WP-G10): one span per OpenSearch query. Attributes carry the
    // provider name and index only — never the query text (user/tenant
    // data). tenant.id is merged automatically by TelemetryService when a
    // tenant scope is active.
    const spanAttributes = {
      'provider.name': 'opensearch',
      'opensearch.index': this.index
    };
    const started = performance.now();
    try {
      return await this.telemetry.withSpan('opensearch.search', spanAttributes, async () => {
        this.assertCircuitClosed();
        try {
          const client = await this.ensureClient();
          return unwrapBody(await this.timedSearch(client, body));
        } catch (error) {
          // Map BEFORE recording so lastErrorClass reflects the provider
          // error taxonomy (timeout/network/http-*), not raw SDK shapes.
          const mapped =
            error instanceof ProviderHttpError || error instanceof ProviderRequestError
              ? error
              : toProviderError(error);
          this.recordFailure(mapped);
          throw mapped;
        }
      });
    } catch (error) {
      this.telemetry.increment('opensearch.search.errors', 1, spanAttributes);
      throw error;
    } finally {
      this.telemetry.record(
        'opensearch.search.duration',
        performance.now() - started,
        spanAttributes
      );
    }
  }

  /**
   * Single search call under the AbortController timeout. The race guard
   * rejects with ProviderRequestError('timeout') at timeoutMs even when the
   * underlying client ignores the abort signal; a client that honours the
   * signal rejects with an abort error, mapped to the same timeout class.
   */
  private timedSearch(client: OpenSearchClientLike, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(
          new ProviderRequestError(
            'opensearch',
            'timeout',
            new Error(`OpenSearch request exceeded ${this.timeoutMs}ms`)
          )
        );
      }, this.timeoutMs);
      client.search({ index: this.index, body }, { signal: controller.signal }).then(
        (raw) => {
          clearTimeout(timer);
          this.recordSuccess();
          resolve(raw);
        },
        (error) => {
          clearTimeout(timer);
          if (controller.signal.aborted) {
            reject(
              new ProviderRequestError('opensearch', 'timeout', error)
            );
            return;
          }
          reject(error);
        }
      );
    });
  }

  private async ensureClient(): Promise<OpenSearchClientLike> {
    if (!this.client) {
      this.client = await this.options.clientFactory();
    }
    return this.client;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'opensearch',
        'network',
        new Error(
          `circuit open after ${this.consecutiveFailures} consecutive failures; retry after cooldown`
        )
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.tracker.recordSuccess();
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.tracker.recordError(error);
    if (this.consecutiveFailures >= OPENSEARCH_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + OPENSEARCH_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Adapts the Meilisearch integration driver (search.drivers.ts) to the
 * search module's provider port. Trending and related delegate to the
 * in-process fallback — they are repository-computed, not index-backed
 * (same discipline as the OpenSearch provider).
 */
export class MeilisearchModuleProvider implements SearchProvider {
  readonly name = 'meilisearch';

  constructor(
    private readonly client: MeilisearchClient,
    private readonly fallbackProvider: SearchProvider
  ) {}

  async search(
    query: string,
    types?: SearchResultType[],
    state?: string,
    limit?: number
  ): Promise<SearchResult[]> {
    const hits = await this.client.search(query, { types, state, limit });
    return hits
      .filter((hit) => KNOWN_TYPES.includes(hit.type as SearchResultType))
      .map((hit) => ({
        type: hit.type as SearchResultType,
        id: hit.id,
        title: hit.title,
        summary: hit.summary,
        score: hit.score,
        ...(hit.state ? { state: hit.state } : {})
      }));
  }

  suggest(query: string, limit?: number): Promise<string[]> {
    return this.client.suggest(query, limit);
  }

  /** Trending is repository-computed (query-log signals) — not index-backed. */
  trending(options?: { now?: Date; limit?: number }): Promise<TrendingQuery[]> {
    return this.fallbackProvider.trending(options);
  }

  /** Related lookups fan out over domain repositories — not index-backed. */
  related(type: SearchResultType, id: string, limit?: number): Promise<SearchResult[]> {
    return this.fallbackProvider.related(type, id, limit);
  }

  /** WP-G10 status accessor — delegates to the underlying Meilisearch driver. */
  status(): Promise<SearchDriverStatus> {
    return this.client.status();
  }
}

/**
 * Selects the search provider for the module query path. Default (stub or
 * unset) returns the existing in-process SearchService unchanged.
 * SEARCH_DRIVER=opensearch requires OPENSEARCH_NODE; SEARCH_DRIVER=
 * meilisearch (or the integration-matrix live modes sandbox/production,
 * whose documented backend is Meilisearch — see adapters.ts) requires
 * MEILISEARCH_HOST. Both fail closed with ProviderConfigError when their
 * backend is unconfigured, and ANY OTHER flag value throws — the factory
 * never silently downgrades a configured live search to the in-process
 * fan-out (mirrors the animal-id-authority unknown-mode throw).
 */
export function createOpenSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
  fallback: SearchProvider
): SearchProvider {
  const flag = (env.SEARCH_DRIVER ?? '').trim().toLowerCase();
  if (flag === '' || flag === 'stub') {
    return fallback;
  }
  if (flag === 'opensearch') {
    const node = requireEnv('opensearch', env, ['OPENSEARCH_NODE']);
    const timeoutMs = parseOpenSearchTimeoutMs(env.OPENSEARCH_TIMEOUT_MS);
    return new OpenSearchSearchProvider({
      clientFactory: () => defaultClientFactory(node, env, timeoutMs),
      fallback,
      index: env.OPENSEARCH_INDEX,
      timeoutMs
    });
  }
  if (flag === 'meilisearch' || flag === 'sandbox' || flag === 'production') {
    // createSearchProvider fails closed without MEILISEARCH_HOST.
    return new MeilisearchModuleProvider(createSearchProvider(env), fallback);
  }
  throw new ProviderConfigError('search', ['SEARCH_DRIVER']);
}
