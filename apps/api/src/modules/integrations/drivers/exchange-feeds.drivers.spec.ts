import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AfexCsvFeedSource,
  createExchangeFeedSources,
  exchangeFeedsDriverEnabled,
  NcxPriceFeedSource,
  parseAfexCsv
} from './exchange-feeds.drivers.js';
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

describe('NcxPriceFeedSource', () => {
  const source = () => new NcxPriceFeedSource('https://ncx.example.com', 'ncx-key');

  it('normalises the REST price feed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { commodity: 'Soybean', market: 'Lagos', state: 'Lagos', price_ngn: 61000, observed_at: '2026-05-01' },
          { commodity: 'Incomplete' }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const readings = await source().fetchLatest();
    expect(readings).toEqual([
      {
        commodity: 'Soybean',
        market: 'Lagos',
        state: 'Lagos',
        lga: undefined,
        priceNgn: 61000,
        source: 'NCX',
        observedAt: '2026-05-01T00:00:00.000Z'
      }
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ncx.example.com/v1/prices?country=NG');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ncx-key');
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })));
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

describe('AfexCsvFeedSource / parseAfexCsv', () => {
  it('parses the CSV export and skips malformed rows', () => {
    const csv = [
      'commodity,market,state,lga,price_ngn,observed_at',
      'Maize,Dawanau,Kano,Dawakin Kudu,42000,2026-05-01T00:00:00Z',
      'Rice,,Kano,,not-a-number,2026-05-01',
      ',Bodija,Oyo,,51000,2026-05-01'
    ].join('\n');
    const readings = parseAfexCsv(csv);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      commodity: 'Maize',
      market: 'Dawanau',
      state: 'Kano',
      lga: 'Dawakin Kudu',
      priceNgn: 42000,
      source: 'AFEX'
    });
  });

  it('pulls the feed over authenticated HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('commodity,market,state,lga,price_ngn,observed_at\nSorghum,Gulbi,Yobe,,33000,2026-05-02', {
        status: 200
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const source = new AfexCsvFeedSource('https://ftp.afex.example.com/prices.csv', 'afex-key');
    const readings = await source.fetchLatest();
    expect(readings).toHaveLength(1);
    expect(readings[0].commodity).toBe('Sorghum');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer afex-key');
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    await expect(
      new AfexCsvFeedSource('https://ftp.afex.example.com/x.csv', 'k').fetchLatest()
    ).rejects.toThrow(ProviderHttpError);
  });
});

describe('createExchangeFeedSources (fail closed)', () => {
  it('returns no sources while the driver is stub', () => {
    expect(createExchangeFeedSources({ EXCHANGE_FEEDS_DRIVER: 'stub' })).toEqual([]);
    expect(exchangeFeedsDriverEnabled({ EXCHANGE_FEEDS_DRIVER: 'stub' })).toBe(false);
  });

  it('raises ProviderConfigError when a feed URL lacks its API key', () => {
    expect(() =>
      createExchangeFeedSources({ EXCHANGE_FEEDS_DRIVER: 'live', NCX_BASE_URL: 'https://n.example' })
    ).toThrow(ProviderConfigError);
  });

  it('builds keyed sources and enables the driver', () => {
    const env = {
      EXCHANGE_FEEDS_DRIVER: 'live',
      NCX_BASE_URL: 'https://n.example',
      NCX_API_KEY: 'k',
      AFEX_FEED_URL: 'https://a.example/x.csv',
      AFEX_API_KEY: 'k2'
    };
    expect(createExchangeFeedSources(env)).toHaveLength(2);
    expect(exchangeFeedsDriverEnabled(env)).toBe(true);
  });
});
