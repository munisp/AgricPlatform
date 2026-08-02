import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExtensionFeedSources,
  extensionFeedDriverEnabled,
  FmardExtensionSource,
  NaerlsExtensionSource
} from './extension-feeds.drivers.js';
import { ProviderConfigError, ProviderHttpError } from './http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError'))
      );
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('NaerlsExtensionSource', () => {
  const source = () => new NaerlsExtensionSource('https://naerls.example.com', 'n-key');

  it('normalises pest alerts with region tagging', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        bulletins: [
          {
            id: 'b-1',
            kind: 'pest_alert',
            title: 'Fall armyworm outbreak',
            summary: 'Scout maize fields',
            region: 'Kaduna',
            crop: 'Maize',
            severity: 'critical',
            published_at: '2026-05-01T08:00:00Z'
          },
          { title: 'no id — skipped' }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const bulletins = await source().fetchLatest();
    expect(bulletins).toHaveLength(1);
    expect(bulletins[0]).toMatchObject({
      externalId: 'b-1',
      kind: 'pest_alert',
      state: 'Kaduna',
      severity: 'critical',
      source: 'NAERLS'
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('n-key');
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 403 })));
    await expect(source().fetchLatest()).rejects.toThrow(ProviderHttpError);
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    await expect(source().fetchLatest()).rejects.toThrow(ProviderHttpError);
  });

  it('maps timeouts to ProviderRequestError(timeout)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const assertion = expect(source().fetchLatest()).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'timeout'
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('FmardExtensionSource', () => {
  it('normalises agronomy guides from the data envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: 12,
              type: 'guide',
              title: 'Cassava weed management',
              body: 'Herbicide timing',
              state: 'Ogun',
              date: '2026-04-20'
            }
          ]
        })
      )
    );
    const bulletins = await new FmardExtensionSource('https://fmard.example.com', 'f-key').fetchLatest();
    expect(bulletins).toHaveLength(1);
    expect(bulletins[0]).toMatchObject({
      externalId: '12',
      kind: 'guide',
      title: 'Cassava weed management',
      state: 'Ogun',
      source: 'FMARD'
    });
  });
});

describe('createExtensionFeedSources (fail closed)', () => {
  it('returns no sources while the driver is stub', () => {
    expect(createExtensionFeedSources({ EXTENSION_FEED_DRIVER: 'stub' })).toEqual([]);
    expect(extensionFeedDriverEnabled({ EXTENSION_FEED_DRIVER: 'stub' })).toBe(false);
  });

  it('raises ProviderConfigError when a base URL lacks its API key', () => {
    expect(() =>
      createExtensionFeedSources({ EXTENSION_FEED_DRIVER: 'live', FMARD_BASE_URL: 'https://f.example' })
    ).toThrow(ProviderConfigError);
  });

  it('builds keyed sources and enables the driver', () => {
    const env = {
      EXTENSION_FEED_DRIVER: 'sandbox',
      NAERLS_BASE_URL: 'https://n.example',
      NAERLS_API_KEY: 'k'
    };
    expect(createExtensionFeedSources(env)).toHaveLength(1);
    expect(extensionFeedDriverEnabled(env)).toBe(true);
  });
});
