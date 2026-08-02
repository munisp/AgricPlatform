import type pg from 'pg';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  CommodityPrice,
  CommodityPriceCriteria,
  CommodityPriceRepository
} from './commodity-price.repository.js';

// The mapper lives next to the repository (instead of row-mappers.ts) to
// keep the wave P1 diff additive and conflict-free with concurrent waves.
const commodityPriceMapper: RowMapper<CommodityPrice> = {
  columns: [
    'id',
    'commodity',
    'market',
    'state',
    'lga',
    'price_ngn',
    'source',
    'observed_at',
    'ingested_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    commodity: row.commodity as string,
    market: row.market as string,
    state: row.state as string,
    lga: (row.lga as string) ?? undefined,
    priceNgn: Number(row.price_ngn),
    source: row.source as string,
    observedAt: new Date(row.observed_at as string).toISOString(),
    ingestedAt: new Date(row.ingested_at as string).toISOString()
  }),
  toRow: (item) => ({
    id: item.id,
    commodity: item.commodity,
    market: item.market,
    state: item.state,
    lga: item.lga ?? null,
    price_ngn: item.priceNgn,
    source: item.source,
    observed_at: item.observedAt,
    ingested_at: item.ingestedAt
  })
};

export function commodityPriceCriteriaSql(criteria: CommodityPriceCriteria): WhereClause {
  return composeWhere(
    eq('commodity', criteria.commodity),
    eq('market', criteria.market),
    eq('state', criteria.state),
    eq('source', criteria.source)
  );
}

export class PgCommodityPriceRepository
  extends PgRepositoryBase<CommodityPrice, CommodityPriceCriteria>
  implements CommodityPriceRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'advisory.commodity_prices',
      mapper: commodityPriceMapper,
      criteria: commodityPriceCriteriaSql,
      orderBy: 'observed_at DESC, id'
    });
  }

  /**
   * Idempotent ingestion insert: the UNIQUE(commodity, market, source,
   * observed_at) constraint from 006_market_data.sql dedupes re-ingested
   * feed rows; DO NOTHING keeps the scheduler replay-safe.
   */
  async upsertMany(items: CommodityPrice[]): Promise<number> {
    let inserted = 0;
    for (const item of items) {
      const row = commodityPriceMapper.toRow(item);
      const columns = Object.keys(row);
      const values = columns.map((column) => row[column]);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const result = await this.pool.query(
        `INSERT INTO advisory.commodity_prices (${columns.join(', ')}) VALUES (${placeholders}) ` +
          'ON CONFLICT (commodity, market, source, observed_at) DO NOTHING',
        values
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }
}

export function createPgCommodityPriceRepository(pool: pg.Pool): PgCommodityPriceRepository {
  return new PgCommodityPriceRepository(pool);
}
