import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from './http.js';
import {
  createMarketDataSources,
  FewsNetMarketDataSource,
  marketDataDriverEnabled,
  NimetMarketDataSource
} from './market-data.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FewsNetMarketDataSource', () => {
  it('normalises the data envelope into price readings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            product: 'Maize (white)',
            market: 'Dawanau',
            admin1: 'Kano',
            admin2: 'Tofa',
            price: 42000,
            period_date: '2025-01-15'
          },
          { product: 'Rice', market: 'NoState', price: 55000, period_date: '2025-01-15' },
          { commodity: 'Sorghum', market_name: 'Bodija', state: 'Oyo', value: 38500, date: '2025-01-14' }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const source = new FewsNetMarketDataSource('fews-key');
    const readings = await source.fetchLatest();
    expect(readings).toHaveLength(2);
    expect(readings[0]).toEqual({
      commodity: 'Maize (white)',
      market: 'Dawanau',
      state: 'Kano',
      lga: 'Tofa',
      priceNgn: 42000,
      source: 'FEWS NET',
      observedAt: new Date('2025-01-15').toISOString()
    });
    expect(readings[1]).toMatchObject({ commodity: 'Sorghum', market: 'Bodija', state: 'Oyo' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://fdw.fews.net/api/marketpricepoints');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fews-key');
  });

  it('accepts a bare array payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          { product: 'Cowpea', market: 'Mile 12', admin1: 'Lagos', price: 61000, date: '2025-02-01' }
        ])
      )
    );
    const source = new FewsNetMarketDataSource('k');
    const readings = await source.fetchLatest();
    expect(readings).toHaveLength(1);
    expect(readings[0].state).toBe('Lagos');
  });

  it('propagates provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
    await expect(new FewsNetMarketDataSource('bad').fetchLatest()).rejects.toThrow(ProviderHttpError);
  });
});

describe('NimetMarketDataSource', () => {
  it('normalises records with the x-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        records: [
          { commodity: 'Cassava (gari)', market: 'Bodija', state: 'Oyo', lga: 'Ibadan North', price_ngn: 18500, observed_at: '2025-01-20T00:00:00Z' }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const source = new NimetMarketDataSource('nimet-key');
    const readings = await source.fetchLatest();
    expect(readings).toEqual([
      {
        commodity: 'Cassava (gari)',
        market: 'Bodija',
        state: 'Oyo',
        lga: 'Ibadan North',
        priceNgn: 18500,
        source: 'NiMet',
        observedAt: '2025-01-20T00:00:00.000Z'
      }
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('nimet-key');
  });

  it('skips rows that cannot be normalised', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([{ commodity: 'Yam' }, { crop: 'Yam', market: 'Zuba', state: 'FCT', price: 9000, date: '2025-01-10' }])
      )
    );
    const source = new NimetMarketDataSource('k');
    const readings = await source.fetchLatest();
    expect(readings).toHaveLength(1);
    expect(readings[0].commodity).toBe('Yam');
  });
});

describe('market data driver gating', () => {
  it('is disabled by default and enabled with live flag + a credential', () => {
    expect(marketDataDriverEnabled({})).toBe(false);
    expect(marketDataDriverEnabled({ MARKET_DATA_DRIVER: 'stub' })).toBe(false);
    expect(marketDataDriverEnabled({ MARKET_DATA_DRIVER: 'live' })).toBe(false);
    expect(marketDataDriverEnabled({ MARKET_DATA_DRIVER: 'live', FEWS_NET_API_KEY: 'k' })).toBe(true);
    expect(marketDataDriverEnabled({ MARKET_DATA_DRIVER: 'sandbox', NIMET_API_KEY: 'k' })).toBe(true);
  });

  it('builds sources only for keyed feeds', () => {
    expect(createMarketDataSources({})).toEqual([]);
    const sources = createMarketDataSources({ FEWS_NET_API_KEY: 'a', NIMET_API_KEY: 'b' });
    expect(sources.map((s) => s.name)).toEqual(['fews-net', 'nimet']);
  });
});
