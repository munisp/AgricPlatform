import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { CommodityPrice } from './commodity-price.repository.js';
import { PgCommodityPriceRepository } from './commodity-price.pg-repository.js';

/**
 * P2 perf query-spy tests: upsertMany must insert in chunked multi-row
 * statements (one round-trip per chunk) instead of one per item, keeping the
 * ON CONFLICT DO NOTHING dedupe semantics and the inserted-row count.
 */

function price(id: string): CommodityPrice {
  return {
    id,
    commodity: 'maize',
    market: 'Kano',
    state: 'Kano',
    priceNgn: 42000,
    source: 'stub',
    observedAt: '2026-01-01T00:00:00.000Z',
    ingestedAt: '2026-01-01T00:00:00.000Z'
  };
}

function spyPool(rowCount = 1) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: [], rowCount };
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe('PgCommodityPriceRepository.upsertMany (P2 batched insert)', () => {
  it('inserts multiple rows in ONE multi-row statement', async () => {
    const { pool, calls } = spyPool(2);
    const repo = new PgCommodityPriceRepository(pool);

    const inserted = await repo.upsertMany([price('p-1'), price('p-2')]);

    expect(inserted).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO advisory.commodity_prices');
    expect(calls[0].text).toContain('ON CONFLICT (commodity, market, source, observed_at) DO NOTHING');
    // Two VALUES tuples: 2 × column-count bind params.
    const tupleCount = (calls[0].text.match(/\(\$\d+(, \$\d+)*\)/g) ?? []).length;
    expect(tupleCount).toBe(2);
    const columnsPerRow = (calls[0].params?.length ?? 0) / 2;
    expect(Number.isInteger(columnsPerRow)).toBe(true);
    expect(calls[0].params).toContain('p-1');
    expect(calls[0].params).toContain('p-2');
  });

  it('chunks large batches (501 rows → 2 statements)', async () => {
    const { pool, calls } = spyPool(1);
    const repo = new PgCommodityPriceRepository(pool);

    const items = Array.from({ length: 501 }, (_, index) => price(`p-${index}`));
    const inserted = await repo.upsertMany(items);

    expect(calls).toHaveLength(2);
    expect(inserted).toBe(2);
  });

  it('is a no-op for an empty batch', async () => {
    const { pool, calls } = spyPool();
    const repo = new PgCommodityPriceRepository(pool);

    expect(await repo.upsertMany([])).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
