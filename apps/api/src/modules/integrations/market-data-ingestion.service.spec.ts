import { describe, expect, it } from 'vitest';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
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

describe('MarketDataIngestionService bounded retry (GAP-M10)', () => {
  /** Fast retry knobs: 3 attempts, 1ms base backoff. */
  const retryEnv = {
    MARKET_DATA_DRIVER: 'live',
    FEWS_NET_API_KEY: 'k',
    MARKET_DATA_INGEST_MAX_ATTEMPTS: '3',
    MARKET_DATA_INGEST_RETRY_BASE_MS: '1'
  };

  const flakySource = (failures: number): { source: MarketDataSource; calls: () => number } => {
    let calls = 0;
    return {
      calls: () => calls,
      source: {
        name: 'flaky',
        fetchLatest: async () => {
          calls += 1;
          if (calls <= failures) {
            throw new Error('feed outage');
          }
          return [
            {
              commodity: 'Maize',
              market: 'Dawanau',
              state: 'Kano',
              priceNgn: 42000,
              source: 'FEWS NET',
              observedAt: '2025-01-15T00:00:00.000Z'
            }
          ];
        }
      }
    };
  };

  it('retries a transient failure with backoff and succeeds within the bound', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    const flaky = flakySource(2);
    const service = new MarketDataIngestionService(repo, [flaky.source], { ...retryEnv });
    expect(await service.ingestOnce()).toBe(1);
    expect(flaky.calls()).toBe(3); // two failures + one success
  });

  it('exhaustion persists an audit event and rethrows (fail-closed)', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    const flaky = flakySource(Number.MAX_SAFE_INTEGER);
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    const service = new MarketDataIngestionService(repo, [flaky.source], { ...retryEnv }, events);

    await expect(service.ingestOnce()).rejects.toThrow('feed outage');
    expect(flaky.calls()).toBe(3); // bounded: exactly MAX_ATTEMPTS tries

    // Durable failure record in events.outbox (audit-only classification).
    const records = await outbox.list();
    expect(records.map((event) => event.name)).toContain('advisory.market_data_ingestion.failed');
    const record = records.find((event) => event.name === 'advisory.market_data_ingestion.failed');
    expect(record?.payload).toMatchObject({ sources: ['flaky'], attempts: 3, error: 'feed outage' });
  });

  it('without a wired event spine the exhaustion still rethrows the original error', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    const flaky = flakySource(Number.MAX_SAFE_INTEGER);
    const service = new MarketDataIngestionService(repo, [flaky.source], { ...retryEnv });
    await expect(service.ingestOnce()).rejects.toThrow('feed outage');
    expect(flaky.calls()).toBe(3);
  });
});
