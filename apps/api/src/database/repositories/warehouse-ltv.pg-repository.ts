import type pg from 'pg';
import type {
  CollateralPosition,
  CollateralPositionStatus,
  LtvObservation,
  LtvPriceBasis
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  mapPgError,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  CollateralPositionCriteria,
  CollateralPositionRepository,
  LtvObservationCriteria,
  LtvObservationRepository
} from './warehouse-ltv.repository.js';

// The mappers live next to the repository (instead of row-mappers.ts) to
// keep the Stage 27 diff additive and conflict-free with concurrent waves —
// the commodity-price.pg-repository precedent.

/** node-pg returns numeric/int8 as string; convert explicitly. */
function num(value: unknown): number {
  return Number(value);
}

function ts(value: unknown): string {
  return new Date(value as string).toISOString();
}

/** present-style toRow: only keys actually on the (possibly partial) item. */
function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof T>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

const collateralPositionMapper: RowMapper<CollateralPosition> = {
  columns: [
    'id',
    'receipt_id',
    'loan_id',
    'lender_id',
    'borrower_id',
    'ledger_account_code',
    'pledged_qty_kg',
    'commodity',
    'haircut_bps',
    'ltv_limit_bps',
    'margin_call_bps',
    'status',
    'price_stale',
    'opened_at',
    'closed_at',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    receiptId: row.receipt_id as string,
    loanId: row.loan_id as string,
    lenderId: row.lender_id as string,
    borrowerId: row.borrower_id as string,
    ledgerAccountCode: row.ledger_account_code as string,
    pledgedQtyKg: num(row.pledged_qty_kg),
    commodity: row.commodity as string,
    haircutBps: num(row.haircut_bps),
    ltvLimitBps: num(row.ltv_limit_bps),
    marginCallBps: num(row.margin_call_bps),
    status: row.status as CollateralPositionStatus,
    priceStale: row.price_stale as boolean,
    openedAt: ts(row.opened_at),
    closedAt: row.closed_at != null ? ts(row.closed_at) : undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      receipt_id: 'receiptId',
      loan_id: 'loanId',
      lender_id: 'lenderId',
      borrower_id: 'borrowerId',
      ledger_account_code: 'ledgerAccountCode',
      pledged_qty_kg: 'pledgedQtyKg',
      commodity: 'commodity',
      haircut_bps: 'haircutBps',
      ltv_limit_bps: 'ltvLimitBps',
      margin_call_bps: 'marginCallBps',
      status: 'status',
      price_stale: 'priceStale',
      opened_at: 'openedAt',
      closed_at: 'closedAt',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export function collateralPositionCriteriaSql(criteria: CollateralPositionCriteria): WhereClause {
  return composeWhere(
    eq('receipt_id', criteria.receiptId),
    eq('loan_id', criteria.loanId),
    eq('lender_id', criteria.lenderId),
    eq('borrower_id', criteria.borrowerId),
    eq('status', criteria.status)
  );
}

export class PgCollateralPositionRepository
  extends PgRepositoryBase<CollateralPosition, CollateralPositionCriteria>
  implements CollateralPositionRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'warehouse.collateral_positions',
      mapper: collateralPositionMapper,
      criteria: collateralPositionCriteriaSql
    });
  }
}

export function createPgCollateralPositionRepository(pool: pg.Pool): PgCollateralPositionRepository {
  return new PgCollateralPositionRepository(pool);
}

/* --------------------------------------------------------- observations -- */

const ltvObservationMapper: RowMapper<LtvObservation> = {
  columns: [
    'id',
    'position_id',
    'price_per_kg_kobo',
    'price_basis',
    'outstanding_kobo',
    'ltv_bps',
    'observed_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    positionId: row.position_id as string,
    pricePerKgKobo: num(row.price_per_kg_kobo),
    priceBasis: row.price_basis as LtvPriceBasis,
    outstandingKobo: num(row.outstanding_kobo),
    ltvBps: num(row.ltv_bps),
    observedAt: ts(row.observed_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      position_id: 'positionId',
      price_per_kg_kobo: 'pricePerKgKobo',
      price_basis: 'priceBasis',
      outstanding_kobo: 'outstandingKobo',
      ltv_bps: 'ltvBps',
      observed_at: 'observedAt'
    })
};

/**
 * Append-only pg implementation of the observation log: INSERT and SELECT
 * only. There is deliberately no UPDATE/DELETE — observations are the
 * evidence trail behind margin-call decisions.
 */
export class PgLtvObservationRepository implements LtvObservationRepository {
  private readonly selectList = ltvObservationMapper.columns.join(', ');

  constructor(private readonly pool: pg.Pool) {}

  async append(observation: LtvObservation): Promise<LtvObservation> {
    try {
      await this.pool.query(
        `INSERT INTO warehouse.ltv_observations
           (id, position_id, price_per_kg_kobo, price_basis, outstanding_kobo, ltv_bps, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          observation.id,
          observation.positionId,
          observation.pricePerKgKobo,
          observation.priceBasis,
          observation.outstandingKobo,
          observation.ltvBps,
          observation.observedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return observation;
  }

  async find(criteria: LtvObservationCriteria): Promise<LtvObservation[]> {
    const { where, params } = composeWhere(eq('position_id', criteria.positionId));
    const result = await this.pool.query(
      `SELECT ${this.selectList} FROM warehouse.ltv_observations${where} ORDER BY observed_at, id`,
      params
    );
    return result.rows.map((row) => ltvObservationMapper.fromRow(row));
  }

  async findById(id: string): Promise<LtvObservation | undefined> {
    const result = await this.pool.query(
      `SELECT ${this.selectList} FROM warehouse.ltv_observations WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? ltvObservationMapper.fromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<LtvObservation[]> {
    const result = await this.pool.query(
      `SELECT ${this.selectList} FROM warehouse.ltv_observations ORDER BY observed_at, id`
    );
    return result.rows.map((row) => ltvObservationMapper.fromRow(row));
  }
}

export function createPgLtvObservationRepository(pool: pg.Pool): PgLtvObservationRepository {
  return new PgLtvObservationRepository(pool);
}
