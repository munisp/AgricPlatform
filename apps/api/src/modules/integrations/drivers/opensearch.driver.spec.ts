import { describe, expect, it, vi } from 'vitest';
import type { SearchProvider } from '../../search/search.provider.js';
import { ProviderConfigError, ProviderHttpError, ProviderRequestError } from './http.js';
import {
  createOpenSearchProvider,
  OpenSearchSearchProvider,
  type OpenSearchClientLike
} from './opensearch.driver.js';

function fakeFallback(): SearchProvider & { trending: ReturnType<typeof vi.fn>; related: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn(),
    suggest: vi.fn(),
    trending: vi.fn().mockResolvedValue([{ query: 'maize' }]),
    related: vi.fn().mockResolvedValue([{ type: 'course', id: 'c1' }])
  } as never;
}

function clientReturning(body: unknown): OpenSearchClientLike {
  return { search: vi.fn().mockResolvedValue({ body }) };
}

describe('createOpenSearchProvider selection', () => {
  it('returns the in-process fallback when SEARCH_DRIVER is unset or stub', () => {
    const fallback = fakeFallback();
    expect(createOpenSearchProvider({}, fallback)).toBe(fallback);
    expect(createOpenSearchProvider({ SEARCH_DRIVER: 'stub' }, fallback)).toBe(fallback);
    expect(createOpenSearchProvider({ SEARCH_DRIVER: 'production' }, fallback)).toBe(fallback);
  });

  it('fails closed when opensearch is selected without OPENSEARCH_NODE', () => {
    expect(() =>
      createOpenSearchProvider({ SEARCH_DRIVER: 'opensearch' }, fakeFallback())
    ).toThrow(ProviderConfigError);
  });

  it('builds the opensearch provider when node is configured', () => {
    const provider = createOpenSearchProvider(
      { SEARCH_DRIVER: 'opensearch', OPENSEARCH_NODE: 'http://localhost:9200' },
      fakeFallback()
    );
    expect(provider).toBeInstanceOf(OpenSearchSearchProvider);
    expect((provider as OpenSearchSearchProvider).name).toBe('opensearch');
  });
});

describe('OpenSearchSearchProvider query path', () => {
  const hits = {
    hits: {
      hits: [
        {
          _id: 'doc-1',
          _score: 3.5,
          _source: { type: 'course', title: 'Maize agronomy', summary: 'Grow maize', state: 'Kano' }
        },
        { _id: 'doc-2', _score: 1.2, _source: { type: 'unknown-type', title: 'Skip me' } }
      ]
    }
  };

  it('builds a bool query with type/state filters and maps hits to SearchResult', async () => {
    const client = clientReturning(hits);
    const provider = new OpenSearchSearchProvider({
      clientFactory: () => Promise.resolve(client),
      fallback: fakeFallback()
    });
    const results = await provider.search('maize', ['course'], 'Kano', 5);
    expect(client.search).toHaveBeenCalledWith({
      index: 'agric-platform',
      body: {
        size: 5,
        query: {
          bool: {
            must: [{ multi_match: { query: 'maize', fields: ['title^2', 'summary'] } }],
            filter: [{ terms: { type: ['course'] } }, { term: { state: 'Kano' } }]
          }
        }
      }
    });
    // Unknown result types are dropped (fail closed on shape).
    expect(results).toEqual([
      {
        type: 'course',
        id: 'doc-1',
        title: 'Maize agronomy',
        summary: 'Grow maize',
        score: 3.5,
        state: 'Kano'
      }
    ]);
  });

  it('uses the configured index override', async () => {
    const client = clientReturning({ hits: { hits: [] } });
    const provider = new OpenSearchSearchProvider({
      clientFactory: () => Promise.resolve(client),
      fallback: fakeFallback(),
      index: 'custom-index'
    });
    await provider.search('maize');
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ index: 'custom-index' })
    );
  });

  it('suggests unique titles via match_phrase_prefix', async () => {
    const client = clientReturning({
      hits: {
        hits: [
          { _source: { title: 'Maize prices' } },
          { _source: { title: 'Maize prices' } },
          { _source: { title: 'Maize storage' } }
        ]
      }
    });
    const provider = new OpenSearchSearchProvider({
      clientFactory: () => Promise.resolve(client),
      fallback: fakeFallback()
    });
    const suggestions = await provider.suggest('maize', 5);
    expect(suggestions).toEqual(['Maize prices', 'Maize storage']);
    expect(client.search).toHaveBeenCalledWith({
      index: 'agric-platform',
      body: {
        size: 5,
        _source: ['title'],
        query: { match_phrase_prefix: { title: 'maize' } }
      }
    });
  });

  it('delegates trending and related to the in-process fallback (not index-backed)', async () => {
    const fallback = fakeFallback();
    const provider = new OpenSearchSearchProvider({
      clientFactory: () => Promise.resolve(clientReturning({})),
      fallback
    });
    await provider.trending({ limit: 3 });
    await provider.related('course', 'c1', 2);
    expect(fallback.trending).toHaveBeenCalledWith({ limit: 3 });
    expect(fallback.related).toHaveBeenCalledWith('course', 'c1', 2);
  });

  it('maps client status codes to ProviderHttpError (fail closed)', async () => {
    const error = Object.assign(new Error('index_not_found'), { statusCode: 404 });
    const provider = new OpenSearchSearchProvider({
      clientFactory: () => Promise.resolve({ search: vi.fn().mockRejectedValue(error) }),
      fallback: fakeFallback()
    });
    await expect(provider.search('maize')).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('maps transport failures to ProviderRequestError (fail closed)', async () => {
    const provider = new OpenSearchSearchProvider({
      clientFactory: () =>
        Promise.resolve({ search: vi.fn().mockRejectedValue(new TypeError('ECONNREFUSED')) }),
      fallback: fakeFallback()
    });
    await expect(provider.search('maize')).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
