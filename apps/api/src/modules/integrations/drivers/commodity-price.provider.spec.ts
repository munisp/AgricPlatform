import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCommodityPriceProvider,
  FixtureCommodityPriceProvider,
  HttpCommodityPriceProvider,
  UnconfiguredCommodityPriceProvider
} from './commodity-price.provider.js';

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('createCommodityPriceProvider (Wave P)', () => {
  it('defaults to fail-closed unconfigured when no driver is set', () => {
    delete process.env.COMMODITY_PRICE_DRIVER;
    const provider = createCommodityPriceProvider({});
    expect(provider).toBeInstanceOf(UnconfiguredCommodityPriceProvider);
    expect(provider.configured).toBe(false);
  });

  it('unconfigured provider rejects with a 503 ServiceUnavailableException', async () => {
    const provider = new UnconfiguredCommodityPriceProvider();
    await expect(provider.fetchQuote('Maize')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(provider.fetchQuote('Maize')).rejects.toThrow(/No commodity price provider/);
  });

  it('selects the fixture driver outside production, clearly labelled', async () => {
    process.env.NODE_ENV = 'test';
    const provider = createCommodityPriceProvider({ COMMODITY_PRICE_DRIVER: 'fixture' });
    expect(provider).toBeInstanceOf(FixtureCommodityPriceProvider);
    const quote = await provider.fetchQuote('Maize', 'Kano');
    expect(quote.source).toMatch(/FIXTURE \(non-production only\)/);
    expect(quote.pricePerTonneNaira).toBeGreaterThan(0);
    expect(quote.state).toBe('Kano');
  });

  it('refuses the fixture driver in production (fail closed)', () => {
    process.env.NODE_ENV = 'production';
    const provider = createCommodityPriceProvider({ COMMODITY_PRICE_DRIVER: 'fixture' });
    expect(provider).toBeInstanceOf(UnconfiguredCommodityPriceProvider);
  });

  it('selects the HTTP driver only with a configured URL', () => {
    process.env.NODE_ENV = 'production';
    expect(
      createCommodityPriceProvider({ COMMODITY_PRICE_DRIVER: 'http' })
    ).toBeInstanceOf(UnconfiguredCommodityPriceProvider);
    const live = createCommodityPriceProvider({
      COMMODITY_PRICE_DRIVER: 'http',
      COMMODITY_PRICE_API_URL: 'https://prices.example.com'
    });
    expect(live).toBeInstanceOf(HttpCommodityPriceProvider);
    expect(live.configured).toBe(true);
  });

  it('HTTP adapter maps the provider payload and fails closed on upstream errors', async () => {
    const okFetch = async () =>
      new Response(
        JSON.stringify({ pricePerTonneNaira: 410000, trend: 'rising', source: 'FEWS NET' }),
        { status: 200 }
      );
    const provider = new HttpCommodityPriceProvider('https://prices.example.com');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = okFetch as typeof fetch;
    try {
      const quote = await provider.fetchQuote('Rice');
      expect(quote.pricePerTonneNaira).toBe(410000);
      expect(quote.trend).toBe('rising');
      expect(quote.source).toBe('FEWS NET');
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () => new Response('down', { status: 502 })) as typeof fetch;
    try {
      await expect(provider.fetchQuote('Rice')).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
