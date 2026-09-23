import { BadRequestException, ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type {
  PoolContribution,
  PoolListing,
  PoolSplitMarker
} from '../../modules/marketplace/coop-pool.js';
import {
  composeWhere,
  eq,
  mapPgError,
  num,
  PgRepositoryBase,
  ts,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { postLedgerEntryTx } from './ledger.pg-repository.js';
import type {
  ContributionCriteria,
  CoopPoolRepository,
  CoopPoolSplitInput,
  PoolCriteria
} from './coop-pool.repository.js';

/**
 * Coop Pool & Split pg repositories (Stage 27 Batch 1, Innovation 2) over
 * infra/postgres/056_coop_pool_split.sql: marketplace.pool_listings,
 * marketplace.pool_contributions, marketplace.pool_split_markers.
 *
 * settleSplit is the money-critical path: ONE database transaction carries
 *   1. the escrow re-verification (status 'released' + exact kobo amount,
 *      row locked FOR UPDATE — never split unverified/unreleased funds),
 *   2. the exactly-once marker claim (targetless ON CONFLICT DO NOTHING on
 *      the pool_id PRIMARY KEY — a committed marker proves the whole split
 *      committed, so a replay no-ops),
 *   3. the pool claim-CAS (locked → settled, guarded UPDATE),
 *   4. the balanced ledger transfer + every member credit posting (the
 *      identical SQL the ledger posting path uses, via postLedgerEntryTx),
 *   5. the in-transaction invariant checks (finance.transfer_is_balanced()
 *      and Σ member credits === the escrow release amount — any violation
 *      rolls the entire settlement back),
 *   6. the member contribution payouts and the marketplace.pool.settled
 *      outbox event.
 */

/** Local `present` helper (same semantics as escrow.mapper.ts). */
function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
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

export const poolListingMapper: RowMapper<PoolListing> = {
  columns: [
    'id',
    'cooperative_id',
    'listing_id',
    'title',
    'crop',
    'unit_price_kobo',
    'location_state',
    'location_lga',
    'location_ward',
    'min_pool_qty_kg',
    'total_qty_kg',
    'status',
    'locked_at',
    'settled_at',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    cooperativeId: row.cooperative_id as string,
    listingId: (row.listing_id as string) ?? undefined,
    title: row.title as string,
    crop: (row.crop as string) ?? undefined,
    unitPriceKobo: num(row.unit_price_kobo),
    location: row.location_state
      ? {
          state: row.location_state as string,
          lga: row.location_lga as string,
          ward: (row.location_ward as string) ?? undefined
        }
      : undefined,
    minPoolQtyKg: num(row.min_pool_qty_kg),
    totalQtyKg: num(row.total_qty_kg),
    status: row.status as PoolListing['status'],
    lockedAt: row.locked_at ? ts(row.locked_at) : undefined,
    settledAt: row.settled_at ? ts(row.settled_at) : undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) => {
    const row = present(item, {
      id: 'id',
      cooperative_id: 'cooperativeId',
      listing_id: 'listingId',
      title: 'title',
      crop: 'crop',
      unit_price_kobo: 'unitPriceKobo',
      min_pool_qty_kg: 'minPoolQtyKg',
      total_qty_kg: 'totalQtyKg',
      status: 'status',
      locked_at: 'lockedAt',
      settled_at: 'settledAt',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    });
    if ('location' in item) {
      row.location_state = item.location?.state ?? null;
      row.location_lga = item.location?.lga ?? null;
      row.location_ward = item.location?.ward ?? null;
    }
    return row;
  }
};

export const poolContributionMapper: RowMapper<PoolContribution> = {
  columns: [
    'id',
    'pool_id',
    'member_user_id',
    'qty_kg',
    'quality_grade',
    'share_bps',
    'ledger_account_code',
    'amount_kobo',
    'status',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    poolId: row.pool_id as string,
    memberUserId: row.member_user_id as string,
    qtyKg: num(row.qty_kg),
    qualityGrade: row.quality_grade as string,
    shareBps: row.share_bps === null ? undefined : num(row.share_bps),
    ledgerAccountCode: row.ledger_account_code as string,
    amountKobo: row.amount_kobo === null ? undefined : num(row.amount_kobo),
    status: row.status as PoolContribution['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      pool_id: 'poolId',
      member_user_id: 'memberUserId',
      qty_kg: 'qtyKg',
      quality_grade: 'qualityGrade',
      share_bps: 'shareBps',
      ledger_account_code: 'ledgerAccountCode',
      amount_kobo: 'amountKobo',
      status: 'status',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

function markerFromRow(row: Record<string, unknown>): PoolSplitMarker {
  return {
    poolId: row.pool_id as string,
    escrowId: row.escrow_id as string,
    ledgerEntryId: row.ledger_entry_id as string,
    totalKobo: num(row.total_kobo),
    memberCount: num(row.member_count),
    idempotencyKey: row.idempotency_key as string,
    createdAt: ts(row.created_at)
  };
}

export function poolCriteriaSql(criteria: PoolCriteria): WhereClause {
  return composeWhere(
    eq('cooperative_id', criteria.cooperativeId),
    eq('listing_id', criteria.listingId),
    eq('status', criteria.status)
  );
}

export function contributionCriteriaSql(criteria: ContributionCriteria): WhereClause {
  return composeWhere(
    eq('pool_id', criteria.poolId),
    eq('member_user_id', criteria.memberUserId),
    eq('status', criteria.status)
  );
}

const CONTRIBUTION_COLUMNS = poolContributionMapper.columns.join(', ');

export class PgCoopPoolRepository
  extends PgRepositoryBase<PoolListing, PoolCriteria>
  implements CoopPoolRepository
{
  /** settleSplit commits marker + postings + state + outbox atomically. */
  readonly transactionalSplit = true;

  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.pool_listings',
      mapper: poolListingMapper,
      criteria: poolCriteriaSql
    });
  }

  async listContributions(criteria: ContributionCriteria): Promise<PoolContribution[]> {
    const { where, params } = contributionCriteriaSql(criteria);
    const result = await this.pool.query(
      `SELECT ${CONTRIBUTION_COLUMNS} FROM marketplace.pool_contributions${where} ORDER BY created_at, id`,
      params
    );
    return result.rows.map((row) => poolContributionMapper.fromRow(row));
  }

  async addContribution(contribution: PoolContribution): Promise<PoolContribution> {
    const row = poolContributionMapper.toRow(contribution);
    const columns = Object.keys(row);
    try {
      await this.pool.query(
        `INSERT INTO marketplace.pool_contributions (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        columns.map((column) => row[column])
      );
    } catch (error) {
      mapPgError(error); // 23505 (pool_id, member_user_id) → 409
    }
    return contribution;
  }

  async updateContribution(
    id: string,
    patch: Partial<PoolContribution>
  ): Promise<PoolContribution> {
    const row = poolContributionMapper.toRow(patch as PoolContribution);
    const columns = Object.keys(row).filter((column) => column !== 'id');
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const result = await this.pool.query(
      `UPDATE marketplace.pool_contributions SET ${assignments}
        WHERE id = $1 RETURNING ${CONTRIBUTION_COLUMNS}`,
      [id, ...columns.map((column) => row[column])]
    );
    if (!result.rows[0]) {
      throw new ConflictException(`Pool contribution '${id}' not found`);
    }
    return poolContributionMapper.fromRow(result.rows[0]);
  }

  async splitMarkerFor(poolId: string): Promise<PoolSplitMarker | undefined> {
    const result = await this.pool.query(
      `SELECT pool_id, escrow_id, ledger_entry_id, total_kobo, member_count, idempotency_key, created_at
         FROM marketplace.pool_split_markers WHERE pool_id = $1`,
      [poolId]
    );
    return result.rows[0] ? markerFromRow(result.rows[0]) : undefined;
  }

  /**
   * Non-transactional marker claim — provided for port completeness; the pg
   * settlement path claims the marker inside settleSplit's transaction.
   */
  async claimSplitMarker(marker: PoolSplitMarker): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO marketplace.pool_split_markers
         (pool_id, escrow_id, ledger_entry_id, total_kobo, member_count, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING pool_id`,
      [
        marker.poolId,
        marker.escrowId,
        marker.ledgerEntryId,
        marker.totalKobo,
        marker.memberCount,
        marker.idempotencyKey
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Single-transaction settlement (see file header). 'replay' means the
   * marker already existed: a previous settle committed the split, so the
   * transaction is rolled back untouched and the caller no-ops.
   */
  async settleSplit(input: CoopPoolSplitInput): Promise<'applied' | 'replay'> {
    return this.withTransaction(async (client) => {
      // 1. Re-verify the escrow inside the transaction: released, exact
      //    kobo amount. Never split unverified or unreleased funds.
      const escrow = await client.query(
        `SELECT status, amount_kobo FROM marketplace.escrow_records
          WHERE id = $1 FOR UPDATE`,
        [input.escrowId]
      );
      const escrowRow = escrow.rows[0] as { status: string; amount_kobo: unknown } | undefined;
      if (!escrowRow || escrowRow.status !== 'released') {
        throw new ConflictException(
          `Escrow '${input.escrowId}' is '${escrowRow?.status ?? 'missing'}'; ` +
            'pool splits only settle a RELEASED escrow'
        );
      }
      if (num(escrowRow.amount_kobo) !== input.marker.totalKobo) {
        throw new BadRequestException(
          `Split total ${input.marker.totalKobo} kobo does not match escrow ` +
            `'${input.escrowId}' release amount ${num(escrowRow.amount_kobo)} kobo`
        );
      }
      // 2. Exactly-once marker claim (targetless ON CONFLICT DO NOTHING).
      const claim = await client.query(
        `INSERT INTO marketplace.pool_split_markers
           (pool_id, escrow_id, ledger_entry_id, total_kobo, member_count, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING pool_id`,
        [
          input.marker.poolId,
          input.marker.escrowId,
          input.marker.ledgerEntryId,
          input.marker.totalKobo,
          input.marker.memberCount,
          input.marker.idempotencyKey
        ]
      );
      if ((claim.rowCount ?? 0) === 0) {
        // A previous settle committed this exact split; roll back the
        // (empty) transaction and let the caller replay the statement.
        throw new PoolSplitReplay();
      }
      // 3. Pool claim-CAS: locked → settled (guarded — a concurrent state
      //    change wins and rolls this settlement back instead).
      const cas = await client.query(
        `UPDATE marketplace.pool_listings
            SET status = 'settled', settled_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'locked'
          RETURNING id`,
        [input.poolId]
      );
      if ((cas.rowCount ?? 0) === 0) {
        throw new ConflictException(
          `Pool '${input.poolId}' is no longer 'locked'; concurrent settlement won the race`
        );
      }
      // 4. The balanced split journal (DR clearing, CR member accounts) with
      //    the marketplace.pool.settled outbox event, same transaction.
      await postLedgerEntryTx(client, input.entry, undefined, input.event);
      // 5. In-transaction invariants: the journal balances and the member
      //    credits sum to exactly the escrow release amount.
      const balanced = await client.query(
        `SELECT finance.transfer_is_balanced($1) AS balanced`,
        [input.entry.id]
      );
      if (balanced.rows[0]?.balanced !== true) {
        throw new BadRequestException(
          `Split journal '${input.entry.id}' failed finance.transfer_is_balanced() — rolled back`
        );
      }
      const creditSum = await client.query(
        `SELECT COALESCE(sum(amount_kobo), 0) AS credits
           FROM finance.ledger_entries
          WHERE transfer_id = $1 AND direction = 'credit'`,
        [input.entry.id]
      );
      if (num(creditSum.rows[0]?.credits ?? 0) !== input.marker.totalKobo) {
        throw new BadRequestException(
          `Split journal '${input.entry.id}' credits do not sum to the escrow release ` +
            `amount ${input.marker.totalKobo} kobo — rolled back`
        );
      }
      // 6. Member payouts recorded on the contributions in the same tx.
      //    P2 perf: ONE set-based UPDATE over the (id, amount) pairs
      //    instead of a per-payout round-trip; same transaction, same
      //    rollback semantics.
      if (input.payouts.length > 0) {
        await client.query(
          `UPDATE marketplace.pool_contributions c
              SET status = 'paid', amount_kobo = p.amount_kobo, updated_at = now()
             FROM unnest($1::text[], $2::bigint[]) AS p(id, amount_kobo)
            WHERE c.id = p.id AND c.pool_id = $3`,
          [
            input.payouts.map((payout) => payout.contributionId),
            input.payouts.map((payout) => payout.amountKobo),
            input.poolId
          ]
        );
      }
      return 'applied' as const;
    }).catch((error: unknown) => {
      if (error instanceof PoolSplitReplay) {
        return 'replay' as const;
      }
      throw error;
    });
  }
}

/** Internal control-flow signal: the split marker already exists. */
class PoolSplitReplay extends Error {
  constructor() {
    super('pool split already committed');
    this.name = 'PoolSplitReplay';
  }
}

export function createPgCoopPoolRepository(pool: pg.Pool): PgCoopPoolRepository {
  return new PgCoopPoolRepository(pool);
}
