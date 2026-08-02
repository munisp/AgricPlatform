import { describe, expect, it } from 'vitest';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import type { MarketDataSource } from './drivers/market-data.drivers.js';
import { MarketDataIngestionService } from './market-data-ingestion.service.js';

const fakeSource = (name: string): MarketDataSource => ({
  name,
  fetchLatest: async () => [
    {
      commodity: 'Maize',
      market: 'Dawanau',
      state: 'Kano',
      priceNgn: 42000,
      source: 'FEWS NET',
      observedAt: '2025-01-15T00:00:00.000Z'
    }
  ]
});

describe('MarketDataIngestionService', () => {
  it('stays disabled without the live flag and credentials', () => {
    const service = new MarketDataIngestionService(
      createInMemoryCommodityPriceRepository(),
      [fakeSource('fews-net')],
      {}
    );
    expect(service.enabled).toBe(false);
    service.onModuleInit(); // no timer scheduled
    service.onModuleDestroy();
  });

  it('is enabled with MARKET_DATA_DRIVER=live and a keyed source', () => {
    const service = new MarketDataIngestionService(
      createInMemoryCommodityPriceRepository(),
      [fakeSource('fews-net')],
      { MARKET_DATA_DRIVER: 'live', FEWS_NET_API_KEY: 'k' }
    );
    expect(service.enabled).toBe(true);
  });

  it('ingests readings into the repository and dedupes reruns', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    const service = new MarketDataIngestionService(repo, [fakeSource('fews-net')], {
      MARKET_DATA_DRIVER: 'live',
      FEWS_NET_API_KEY: 'k'
    });
    expect(await service.ingestOnce()).toBe(1);
    // Replay-safe: the same feed rows are skipped on the next pass.
    expect(await service.ingestOnce()).toBe(0);
    const stored = await repo.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      commodity: 'Maize',
      market: 'Dawanau',
      state: 'Kano',
      priceNgn: 42000,
      source: 'FEWS NET'
    });
    expect(stored[0].id).toMatch(/^price-/);
    expect(stored[0].ingestedAt).toBeTruthy();
  });

  it('aggregates inserts across multiple sources', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    const service = new MarketDataIngestionService(
      repo,
      [fakeSource('fews-net'), fakeSource('nimet')],
      { MARKET_DATA_DRIVER: 'live', FEWS_NET_API_KEY: 'a', NIMET_API_KEY: 'b' }
    );
    // Same unique key from both sources → second one deduped.
    expect(await service.ingestOnce()).toBe(1);
  });
});
