import { describe, expect, it } from 'vitest';
import { createInMemoryCommodityPriceRepository } from '../../../database/repositories/commodity-price.repository.js';
import type { MarketDataSource } from '../drivers/market-data.drivers.js';
import { ExchangeFeedIngestionService } from './exchange-feed-ingestion.service.js';

const fakeSource = (name: string): MarketDataSource => ({
  name,
  fetchLatest: async () => [
    {
      commodity: 'Soybean',
      market: 'Lagos',
      state: 'Lagos',
      priceNgn: 61000,
      source: 'NCX',
      observedAt: '2026-05-01T00:00:00.000Z'
    }
  ]
});

describe('ExchangeFeedIngestionService', () => {
  it('stays disabled without the live flag and credentials', () => {
    const service = new ExchangeFeedIngestionService(
      createInMemoryCommodityPriceRepository(),
      [fakeSource('ncx')],
      {}
    );
    expect(service.enabled).toBe(false);
    service.onModuleInit();
    service.onModuleDestroy();
  });

  it('is enabled with EXCHANGE_FEEDS_DRIVER=live and a keyed source', () => {
    const service = new ExchangeFeedIngestionService(
      createInMemoryCommodityPriceRepository(),
      [fakeSource('ncx')],
      { EXCHANGE_FEEDS_DRIVER: 'live', NCX_BASE_URL: 'https://n.example', NCX_API_KEY: 'k' }
    );
    expect(service.enabled).toBe(true);
  });

  it('ingests into advisory.commodity_prices via the idempotent upsert', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    const service = new ExchangeFeedIngestionService(repo, [fakeSource('ncx')], {
      EXCHANGE_FEEDS_DRIVER: 'live',
      NCX_BASE_URL: 'https://n.example',
      NCX_API_KEY: 'k'
    });
    expect(await service.ingestOnce()).toBe(1);
    expect(await service.ingestOnce()).toBe(0);
    const stored = await repo.all();
    expect(stored[0]).toMatchObject({ commodity: 'Soybean', source: 'NCX', priceNgn: 61000 });
  });
});
