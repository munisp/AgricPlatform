import { describe, expect, it } from 'vitest';
import {
  commodityPriceCriteriaSql,
  PgCommodityPriceRepository
} from './commodity-price.pg-repository.js';
import {
  createInMemoryCommodityPriceRepository,
  type CommodityPrice
} from './commodity-price.repository.js';

const row = (overrides: Partial<CommodityPrice> = {}): CommodityPrice => ({
  id: 'price-1',
  commodity: 'Maize',
  market: 'Dawanau',
  state: 'Kano',
  priceNgn: 42000,
  source: 'FEWS NET',
  observedAt: '2025-01-15T00:00:00.000Z',
  ingestedAt: '2025-01-16T00:00:00.000Z',
  ...overrides
});

describe('InMemoryCommodityPriceRepository', () => {
  it('filters by criteria', async () => {
    const repo = createInMemoryCommodityPriceRepository([
      row(),
      row({ id: 'price-2', commodity: 'Rice', market: 'Mile 12', state: 'Lagos' })
    ]);
    expect(await repo.find({ commodity: 'Maize' })).toHaveLength(1);
    expect(await repo.find({ state: 'Lagos' })).toHaveLength(1);
    expect(await repo.find({ source: 'NiMet' })).toHaveLength(0);
    expect(await repo.count()).toBe(2);
  });

  it('upsertMany inserts new rows and skips duplicate unique keys', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    expect(await repo.upsertMany([row(), row({ id: 'price-2', commodity: 'Rice' })])).toBe(2);
    // Same (commodity, market, source, observedAt) under a new id → skipped.
    expect(await repo.upsertMany([row({ id: 'price-3' })])).toBe(0);
    expect(await repo.count()).toBe(2);
  });

  it('upsertMany dedupes within a single batch', async () => {
    const repo = createInMemoryCommodityPriceRepository();
    expect(await repo.upsertMany([row(), row({ id: 'price-2' })])).toBe(1);
  });

  it('paginates through searchPage', async () => {
    const repo = createInMemoryCommodityPriceRepository(
      Array.from({ length: 5 }, (_, i) => row({ id: `price-${i}`, commodity: `Crop${i}` }))
    );
    const page = await repo.searchPage({}, 2, 2);
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(5);
  });
});

describe('commodityPriceCriteriaSql', () => {
  it('compiles whitelisted equality fragments', () => {
    expect(commodityPriceCriteriaSql({ commodity: 'Maize', state: 'Kano' })).toEqual({
      where: ' WHERE (commodity = $1) AND (state = $2)',
      params: ['Maize', 'Kano']
    });
    expect(commodityPriceCriteriaSql({})).toEqual({ where: '', params: [] });
  });
});

describe('PgCommodityPriceRepository.upsertMany', () => {
  it('emits ON CONFLICT DO NOTHING inserts bound to the unique key', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return { rows: [], rowCount: 1 };
      }
    };
    const repo = new PgCommodityPriceRepository(pool as never);
    expect(await repo.upsertMany([row()])).toBe(1);
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('INSERT INTO advisory.commodity_prices');
    expect(queries[0].text).toContain('ON CONFLICT (commodity, market, source, observed_at) DO NOTHING');
    expect(queries[0].values).toContain('Maize');
    expect(queries[0].values).toContain(42000);
  });
});
