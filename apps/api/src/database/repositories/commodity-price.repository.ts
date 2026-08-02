import type { ApiListResponse } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Normalised commodity price observation (wave P1 market-data feeds).
 * Persisted in advisory.commodity_prices (infra/postgres/006_market_data.sql).
 */
export interface CommodityPrice {
  id: string;
  commodity: string;
  market: string;
  state: string;
  lga?: string;
  priceNgn: number;
  source: string;
  /** ISO-8601 observation time from the feed. */
  observedAt: string;
  /** ISO-8601 ingestion time (set by the repository caller). */
  ingestedAt: string;
}

export interface CommodityPriceCriteria {
  commodity?: string;
  market?: string;
  state?: string;
  source?: string;
}

export interface CommodityPriceRepository
  extends AsyncRepository<CommodityPrice, CommodityPriceCriteria> {
  /**
   * Idempotent bulk insert used by the ingestion scheduler: rows whose
   * (commodity, market, source, observedAt) already exist are skipped.
   * Returns the number of newly inserted rows.
   */
  upsertMany(items: CommodityPrice[]): Promise<number>;
  searchPage(
    criteria: CommodityPriceCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<CommodityPrice>>;
}

export function commodityPriceMatcher(
  criteria: CommodityPriceCriteria
): (item: CommodityPrice) => boolean {
  return (item) =>
    (!criteria.commodity || item.commodity === criteria.commodity) &&
    (!criteria.market || item.market === criteria.market) &&
    (!criteria.state || item.state === criteria.state) &&
    (!criteria.source || item.source === criteria.source);
}

/** The dedupe key backing the table's UNIQUE constraint. */
export function commodityPriceKey(item: CommodityPrice): string {
  return [item.commodity, item.market, item.source, item.observedAt].join('¦');
}

export class InMemoryCommodityPriceRepository
  extends InMemoryRepository<CommodityPrice, CommodityPriceCriteria>
  implements CommodityPriceRepository
{
  constructor(seed: readonly CommodityPrice[] = []) {
    super(seed, commodityPriceMatcher);
  }

  async upsertMany(items: CommodityPrice[]): Promise<number> {
    const existing = new Set([...this.items.values()].map(commodityPriceKey));
    let inserted = 0;
    for (const item of items) {
      const key = commodityPriceKey(item);
      if (existing.has(key) || this.items.has(item.id)) {
        continue;
      }
      existing.add(key);
      this.items.set(item.id, item);
      inserted += 1;
    }
    return inserted;
  }
}

export function createInMemoryCommodityPriceRepository(
  seed: readonly CommodityPrice[] = []
): InMemoryCommodityPriceRepository {
  return new InMemoryCommodityPriceRepository(seed);
}
