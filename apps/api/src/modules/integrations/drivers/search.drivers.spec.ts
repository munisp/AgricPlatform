import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from './http.js';
import { createSearchProvider, MeilisearchSearchProvider } from './search.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MeilisearchSearchProvider', () => {
  it('searches with query, filters and ranking scores', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        hits: [
          {
            id: 'c-1',
            type: 'course',
            title: 'Agronomy 101',
            summary: 'Basics',
            state: 'Kano',
            _rankingScore: 0.9
          }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new MeilisearchSearchProvider('http://localhost:7700', 'master-key');
    const results = await provider.search('agronomy', { types: ['course'], state: 'Kano', limit: 5 });
    expect(results).toEqual([
      { type: 'course', id: 'c-1', title: 'Agronomy 101', summary: 'Basics', score: 0.9, state: 'Kano' }
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:7700/indexes/agric-platform/search');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer master-key');
    const body = JSON.parse(init.body as string);
    expect(body.q).toBe('agronomy');
    expect(body.filter).toBe("type IN ['course'] AND state = 'Kano'");
  });

  it('works without an API key (self-hosted open instance)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hits: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new MeilisearchSearchProvider('http://meili:7700');
    await provider.search('x');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('suggests titles from search results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ hits: [{ id: '1', title: 'Maize storage' }, { id: '2', title: 'Maize seeds' }] })
      )
    );
    const provider = new MeilisearchSearchProvider('http://meili:7700');
    expect(await provider.suggest('maize')).toEqual(['Maize storage', 'Maize seeds']);
  });

  it('indexes and removes documents', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ taskUid: 1 }, 202)));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new MeilisearchSearchProvider('http://meili:7700', 'k');
    await provider.indexDocuments([{ id: 'd1', type: 'course', title: 'T', summary: 'S' }]);
    await provider.removeDocument('d1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://meili:7700/indexes/agric-platform/documents');
    expect(fetchMock.mock.calls[1][0]).toBe('http://meili:7700/indexes/agric-platform/documents/d1');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('maps provider errors to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no index', { status: 404 })));
    const provider = new MeilisearchSearchProvider('http://meili:7700');
    await expect(provider.search('x')).rejects.toThrow(ProviderHttpError);
  });

  it('status() reports last success / last error class (WP-G10)', async () => {
    const provider = new MeilisearchSearchProvider('http://meili:7700');
    const initial = await provider.status();
    expect(initial.configured).toBe(true);
    expect(initial.healthy).toBe(true);
    expect(initial.lastErrorClass).toBeNull();
    expect(initial.lastSuccessAt).toBeNull();
    expect(initial.detail).toContain('http://meili:7700');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ hits: [] })));
    await provider.search('x');
    const afterSuccess = await provider.status();
    expect(afterSuccess.lastSuccessAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(afterSuccess.lastSuccessAt as string))).toBe(false);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));
    await expect(provider.search('x')).rejects.toThrow(ProviderHttpError);
    const afterFailure = await provider.status();
    expect(afterFailure.lastErrorClass).toBe('http-5xx');
  });
});

describe('createSearchProvider factory (fail closed)', () => {
  it('requires MEILISEARCH_HOST', () => {
    expect(() => createSearchProvider({})).toThrow(ProviderConfigError);
    expect(() => createSearchProvider({ MEILISEARCH_API_KEY: 'k' })).toThrow(/MEILISEARCH_HOST/);
  });

  it('builds the provider from host + optional key', () => {
    expect(
      createSearchProvider({ MEILISEARCH_HOST: 'http://meili:7700', MEILISEARCH_API_KEY: 'k' })
    ).toBeInstanceOf(MeilisearchSearchProvider);
  });
});
