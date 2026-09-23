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

/** Rows per upsertMany statement — keeps pg bind params far below the 65535 limit. */
const UPSERT_CHUNK_SIZE = 500;

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
    // P2 perf: chunked multi-row INSERT (one statement per chunk) instead of
    // a per-item round-trip; ON CONFLICT DO NOTHING keeps the identical
    // dedupe semantics and rowCount still counts only inserted rows.
    let inserted = 0;
    for (let start = 0; start < items.length; start += UPSERT_CHUNK_SIZE) {
      const rows = items
        .slice(start, start + UPSERT_CHUNK_SIZE)
        .map((item) => commodityPriceMapper.toRow(item));
      if (rows.length === 0) {
        break;
      }
      const columns = Object.keys(rows[0]);
      const values: unknown[] = [];
      const tuples = rows.map((row) => {
        const placeholders = columns.map((column) => {
          values.push(row[column]);
          return `$${values.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      const result = await this.pool.query(
        `INSERT INTO advisory.commodity_prices (${columns.join(', ')}) VALUES ${tuples.join(', ')} ` +
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
