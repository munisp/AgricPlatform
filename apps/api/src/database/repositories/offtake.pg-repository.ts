import { BadRequestException, ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type {
  OfftakeAmendment,
  OfftakeContract,
  OfftakeDelivery,
  OfftakeMilestone
} from '../../modules/marketplace/offtake.js';
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
import type {
  OfftakeContractCriteria,
  OfftakeContractRepository,
  OfftakeDeliveryTxInput
} from './offtake.repository.js';

/**
 * Harvest Forward Contracts pg repositories (Stage 27 Batch 3, Innovation
 * 18) over infra/postgres/077_offtake_contracts.sql.
 *
 * recordDeliveryTx is the money-critical path: ONE database transaction
 * carries
 *   1. the contract re-verification (status 'active', row locked
 *      FOR UPDATE — a concurrent fulfilment/default cannot interleave),
 *   2. the exactly-once delivery claim (INSERT … ON CONFLICT
 *      (idempotency_key) DO NOTHING — a committed delivery row proves the
 *      whole saga step committed, so a replay no-ops),
 *   3. the milestone accumulation CAS (delta UPDATE guarded on
 *      status pending|partial and delivered + delta <= qty_kg, with the
 *      derived partial|met status computed IN SQL so concurrent deliveries
 *      cannot double-count or overshoot),
 *   4. the balanced escrow-hold ledger journal (the identical SQL the
 *      ledger posting path uses) plus the finance.transfer_is_balanced()
 *      invariant check — any violation rolls the whole step back,
 *   5. the fulfilment CAS (active -> fulfilled only when every milestone is
 *      met) and all outbox events (delivery_recorded, milestone_met,
 *      fulfilled).
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

/** date column row value -> yyyy-mm-dd (pg returns Date objects). */
function dt(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

export const offtakeContractMapper: RowMapper<OfftakeContract> = {
  columns: [
    'id',
    'cooperative_id',
    'buyer_org_id',
    'commodity',
    'qty_kg',
    'quality_spec',
    'price_band',
    'window_start',
    'window_end',
    'status',
    'idempotency_key',
    'created_by',
    'accepted_at',
    // V-34/V-35 (109_offtake_amendments.sql): versioned terms + default remedy.
    'terms_version',
    'default_penalty_kobo',
    'remarketed_listing_id',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    cooperativeId: row.cooperative_id as string,
    buyerOrgId: row.buyer_org_id as string,
    commodity: row.commodity as string,
    qtyKg: num(row.qty_kg),
    qualitySpec: (row.quality_spec as Record<string, unknown>) ?? {},
    priceBand: row.price_band as OfftakeContract['priceBand'],
    windowStart: dt(row.window_start),
    windowEnd: dt(row.window_end),
    status: row.status as OfftakeContract['status'],
    idempotencyKey: (row.idempotency_key as string) ?? undefined,
    createdBy: row.created_by as string,
    acceptedAt: row.accepted_at ? ts(row.accepted_at) : undefined,
    termsVersion:
      row.terms_version === null || row.terms_version === undefined
        ? undefined
        : num(row.terms_version),
    defaultPenaltyKobo:
      row.default_penalty_kobo === null || row.default_penalty_kobo === undefined
        ? undefined
        : num(row.default_penalty_kobo),
    remarketedListingId: (row.remarketed_listing_id as string) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      cooperative_id: 'cooperativeId',
      buyer_org_id: 'buyerOrgId',
      commodity: 'commodity',
      qty_kg: 'qtyKg',
      quality_spec: 'qualitySpec',
      price_band: 'priceBand',
      window_start: 'windowStart',
      window_end: 'windowEnd',
      status: 'status',
      idempotency_key: 'idempotencyKey',
      created_by: 'createdBy',
      accepted_at: 'acceptedAt',
      terms_version: 'termsVersion',
      default_penalty_kobo: 'defaultPenaltyKobo',
      remarketed_listing_id: 'remarketedListingId',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

/** V-34: amendment row mapper (marketplace.offtake_amendments, migration 109). */
export const offtakeAmendmentMapper: RowMapper<OfftakeAmendment> = {
  columns: [
    'id',
    'contract_id',
    'seq',
    'status',
    'price_band',
    'window_end',
    'milestone_due_dates',
    'note',
    'proposed_by',
    'created_at',
    'decided_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    contractId: row.contract_id as string,
    seq: num(row.seq),
    status: row.status as OfftakeAmendment['status'],
    priceBand: (row.price_band as OfftakeAmendment['priceBand']) ?? undefined,
    windowEnd: row.window_end ? dt(row.window_end) : undefined,
    milestoneDueDates:
      (row.milestone_due_dates as OfftakeAmendment['milestoneDueDates']) ?? undefined,
    note: (row.note as string) ?? undefined,
    proposedBy: row.proposed_by as string,
    createdAt: ts(row.created_at),
    decidedAt: row.decided_at ? ts(row.decided_at) : undefined
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      contract_id: 'contractId',
      seq: 'seq',
      status: 'status',
      price_band: 'priceBand',
      window_end: 'windowEnd',
      milestone_due_dates: 'milestoneDueDates',
      note: 'note',
      proposed_by: 'proposedBy',
      created_at: 'createdAt',
      decided_at: 'decidedAt'
    })
};

const AMENDMENT_COLUMNS = offtakeAmendmentMapper.columns.join(', ');

export const offtakeMilestoneMapper: RowMapper<OfftakeMilestone> = {
  columns: [
    'id',
    'contract_id',
    'seq',
    'due_date',
    'qty_kg',
    'delivered_qty_kg',
    'linked_lot_id',
    'invoice_id',
    'escrow_id',
    'status',
    'created_at',
    'updated_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    contractId: row.contract_id as string,
    seq: num(row.seq),
    dueDate: dt(row.due_date),
    qtyKg: num(row.qty_kg),
    deliveredQtyKg: num(row.delivered_qty_kg),
    linkedLotId: (row.linked_lot_id as string) ?? undefined,
    invoiceId: (row.invoice_id as string) ?? undefined,
    escrowId: (row.escrow_id as string) ?? undefined,
    status: row.status as OfftakeMilestone['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      contract_id: 'contractId',
      seq: 'seq',
      due_date: 'dueDate',
      qty_kg: 'qtyKg',
      delivered_qty_kg: 'deliveredQtyKg',
      linked_lot_id: 'linkedLotId',
      invoice_id: 'invoiceId',
      escrow_id: 'escrowId',
      status: 'status',
      created_at: 'createdAt',
      updated_at: 'updatedAt'
    })
};

export const offtakeDeliveryMapper: RowMapper<OfftakeDelivery> = {
  columns: [
    'id',
    'contract_id',
    'milestone_id',
    'lot_id',
    'order_id',
    'invoice_id',
    'escrow_id',
    'qty_kg',
    'price_kobo_per_kg',
    'amount_kobo',
    'ledger_entry_id',
    'idempotency_key',
    'created_by',
    'created_at'
  ],
  fromRow: (row) => ({
    id: row.id as string,
    contractId: row.contract_id as string,
    milestoneId: row.milestone_id as string,
    lotId: row.lot_id as string,
    orderId: row.order_id as string,
    invoiceId: (row.invoice_id as string) ?? undefined,
    escrowId: (row.escrow_id as string) ?? undefined,
    qtyKg: num(row.qty_kg),
    priceKoboPerKg: num(row.price_kobo_per_kg),
    amountKobo: num(row.amount_kobo),
    ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
    idempotencyKey: (row.idempotency_key as string) ?? undefined,
    createdBy: row.created_by as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) =>
    present(item, {
      id: 'id',
      contract_id: 'contractId',
      milestone_id: 'milestoneId',
      lot_id: 'lotId',
      order_id: 'orderId',
      invoice_id: 'invoiceId',
      escrow_id: 'escrowId',
      qty_kg: 'qtyKg',
      price_kobo_per_kg: 'priceKoboPerKg',
      amount_kobo: 'amountKobo',
      ledger_entry_id: 'ledgerEntryId',
      idempotency_key: 'idempotencyKey',
      created_by: 'createdBy',
      created_at: 'createdAt'
    })
};

export function offtakeContractCriteriaSql(criteria: OfftakeContractCriteria): WhereClause {
  return composeWhere(
    eq('cooperative_id', criteria.cooperativeId),
    eq('buyer_org_id', criteria.buyerOrgId),
    eq('status', criteria.status),
    eq('idempotency_key', criteria.idempotencyKey)
  );
}

const MILESTONE_COLUMNS = offtakeMilestoneMapper.columns.join(', ');
const DELIVERY_COLUMNS = offtakeDeliveryMapper.columns.join(', ');

/**
 * Posts a balanced ledger journal inside an existing transaction, using the
 * identical SQL as PgLedgerEntryRepository.postEntry (transfer row +
 * posting rows + account-code resolution). Kept local so this innovation
 * stays additive — the shared ledger repository file is untouched.
 */
async function postLedgerEntryTx(
  client: pg.PoolClient,
  entry: LedgerJournalEntry
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO finance.ledger_transfers
         (id, idempotency_key, reference_type, reference_id, description, reverses_transfer_id, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id,
        entry.idempotencyKey,
        entry.referenceType ?? null,
        entry.referenceId ?? null,
        entry.description ?? null,
        entry.reversesEntryId ?? null,
        entry.postedAt
      ]
    );
  } catch (error) {
    mapPgError(error);
  }
  for (const posting of entry.postings) {
    const account = await client.query(
      `SELECT id FROM finance.ledger_accounts WHERE code = $1`,
      [posting.accountCode]
    );
    if (!account.rows[0]) {
      throw new BadRequestException(`Unknown ledger account code '${posting.accountCode}'`);
    }
    await client.query(
      `INSERT INTO finance.ledger_entries (transfer_id, account_id, direction, amount_kobo)
       VALUES ($1, $2, $3, $4)`,
      [entry.id, account.rows[0].id, posting.direction, posting.amountKobo]
    );
  }
}

async function appendOutboxTx(client: pg.PoolClient, event: DomainEvent): Promise<void> {
  await client.query(
    `INSERT INTO events.outbox (id, name, payload, actor_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      event.id,
      event.name,
      JSON.stringify(event.payload ?? {}),
      event.actorId ?? null,
      event.occurredAt
    ]
  );
}

export class PgOfftakeContractRepository
  extends PgRepositoryBase<OfftakeContract, OfftakeContractCriteria>
  implements OfftakeContractRepository
{
  /** recordDeliveryTx commits claim + accumulation + journal + outbox atomically. */
  readonly transactionalDelivery = true;

  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'marketplace.offtake_contracts',
      mapper: offtakeContractMapper,
      criteria: offtakeContractCriteriaSql,
      orderBy: 'created_at, id'
    });
  }

  async addMilestones(milestones: readonly OfftakeMilestone[]): Promise<void> {
    for (const milestone of milestones) {
      const row = offtakeMilestoneMapper.toRow(milestone);
      const columns = Object.keys(row);
      try {
        await this.pool.query(
          `INSERT INTO marketplace.offtake_milestones (${columns.join(', ')})
           VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
          columns.map((column) => row[column])
        );
      } catch (error) {
        mapPgError(error); // 23505 (contract_id, seq) → 409
      }
    }
  }

  async listMilestones(contractId: string): Promise<OfftakeMilestone[]> {
    const result = await this.pool.query(
      `SELECT ${MILESTONE_COLUMNS} FROM marketplace.offtake_milestones
        WHERE contract_id = $1 ORDER BY seq`,
      [contractId]
    );
    return result.rows.map((row) => offtakeMilestoneMapper.fromRow(row));
  }

  async milestoneBySeq(
    contractId: string,
    seq: number
  ): Promise<OfftakeMilestone | undefined> {
    const result = await this.pool.query(
      `SELECT ${MILESTONE_COLUMNS} FROM marketplace.offtake_milestones
        WHERE contract_id = $1 AND seq = $2`,
      [contractId, seq]
    );
    return result.rows[0] ? offtakeMilestoneMapper.fromRow(result.rows[0]) : undefined;
  }

  async milestoneByEscrowId(escrowId: string): Promise<OfftakeMilestone | undefined> {
    const result = await this.pool.query(
      `SELECT ${MILESTONE_COLUMNS} FROM marketplace.offtake_milestones
        WHERE escrow_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [escrowId]
    );
    return result.rows[0] ? offtakeMilestoneMapper.fromRow(result.rows[0]) : undefined;
  }

  async listDeliveries(contractId: string): Promise<OfftakeDelivery[]> {
    const result = await this.pool.query(
      `SELECT ${DELIVERY_COLUMNS} FROM marketplace.offtake_deliveries
        WHERE contract_id = $1 ORDER BY created_at, id`,
      [contractId]
    );
    return result.rows.map((row) => offtakeDeliveryMapper.fromRow(row));
  }

  async deliveryByIdempotencyKey(idempotencyKey: string): Promise<OfftakeDelivery | undefined> {
    const result = await this.pool.query(
      `SELECT ${DELIVERY_COLUMNS} FROM marketplace.offtake_deliveries
        WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] ? offtakeDeliveryMapper.fromRow(result.rows[0]) : undefined;
  }

  /** Non-transactional insert — port completeness; the saga uses recordDeliveryTx. */
  async addDelivery(delivery: OfftakeDelivery): Promise<OfftakeDelivery> {
    const row = offtakeDeliveryMapper.toRow(delivery);
    const columns = Object.keys(row);
    try {
      await this.pool.query(
        `INSERT INTO marketplace.offtake_deliveries (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        columns.map((column) => row[column])
      );
    } catch (error) {
      mapPgError(error); // 23505 idempotency_key → 409
    }
    return delivery;
  }

  async updateMilestoneExpected(
    id: string,
    patch: Partial<OfftakeMilestone>,
    expected: Partial<OfftakeMilestone>
  ): Promise<OfftakeMilestone> {
    const row = offtakeMilestoneMapper.toRow(patch as OfftakeMilestone);
    const columns = Object.keys(row).filter((column) => column !== 'id');
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const expectedRow = offtakeMilestoneMapper.toRow(expected as OfftakeMilestone);
    const expectedColumns = Object.keys(expectedRow).filter((column) => column !== 'id');
    const offset = columns.length + 1;
    const preconditions = expectedColumns
      .map((column, index) => `${column} = $${offset + index + 1}`)
      .join(' AND ');
    const result = await this.pool.query(
      `UPDATE marketplace.offtake_milestones SET ${assignments}
        WHERE id = $1${preconditions ? ` AND ${preconditions}` : ''}
        RETURNING ${MILESTONE_COLUMNS}`,
      [
        id,
        ...columns.map((column) => row[column]),
        ...expectedColumns.map((column) => expectedRow[column])
      ]
    );
    if (!result.rows[0]) {
      throw new ConflictException(
        `Concurrent state change on offtake milestone '${id}'; re-read and retry the operation`
      );
    }
    return offtakeMilestoneMapper.fromRow(result.rows[0]);
  }

  /* ---------------------------- V-34: amendments ------------------------- */

  async addAmendment(amendment: OfftakeAmendment): Promise<OfftakeAmendment> {
    const row = offtakeAmendmentMapper.toRow(amendment);
    const columns = Object.keys(row);
    try {
      await this.pool.query(
        `INSERT INTO marketplace.offtake_amendments (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        columns.map((column) => row[column])
      );
    } catch (error) {
      mapPgError(error); // 23505 (contract_id, seq) → 409
    }
    return amendment;
  }

  async listAmendments(contractId: string): Promise<OfftakeAmendment[]> {
    const result = await this.pool.query(
      `SELECT ${AMENDMENT_COLUMNS} FROM marketplace.offtake_amendments
        WHERE contract_id = $1 ORDER BY seq`,
      [contractId]
    );
    return result.rows.map((row) => offtakeAmendmentMapper.fromRow(row));
  }

  async amendmentById(id: string): Promise<OfftakeAmendment | undefined> {
    const result = await this.pool.query(
      `SELECT ${AMENDMENT_COLUMNS} FROM marketplace.offtake_amendments WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? offtakeAmendmentMapper.fromRow(result.rows[0]) : undefined;
  }

  async updateAmendmentExpected(
    id: string,
    patch: Partial<OfftakeAmendment>,
    expected: Partial<OfftakeAmendment>
  ): Promise<OfftakeAmendment> {
    const row = offtakeAmendmentMapper.toRow(patch as OfftakeAmendment);
    const columns = Object.keys(row).filter((column) => column !== 'id');
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const expectedRow = offtakeAmendmentMapper.toRow(expected as OfftakeAmendment);
    const expectedColumns = Object.keys(expectedRow).filter((column) => column !== 'id');
    const offset = columns.length + 1;
    const preconditions = expectedColumns
      .map((column, index) => `${column} = $${offset + index + 1}`)
      .join(' AND ');
    const result = await this.pool.query(
      `UPDATE marketplace.offtake_amendments SET ${assignments}
        WHERE id = $1${preconditions ? ` AND ${preconditions}` : ''}
        RETURNING ${AMENDMENT_COLUMNS}`,
      [
        id,
        ...columns.map((column) => row[column]),
        ...expectedColumns.map((column) => expectedRow[column])
      ]
    );
    if (!result.rows[0]) {
      throw new ConflictException(
        `Concurrent state change on offtake amendment '${id}'; re-read and retry the operation`
      );
    }
    return offtakeAmendmentMapper.fromRow(result.rows[0]);
  }

  /**
   * Single-transaction delivery saga step (see file header). 'replay' means
   * the delivery idempotency key was already committed: the transaction is
   * rolled back untouched and the caller replays the recorded delivery.
   */
  async recordDeliveryTx(input: OfftakeDeliveryTxInput): Promise<'applied' | 'replay'> {
    return this.withTransaction(async (client) => {
      // 1. Re-verify the contract inside the transaction (row locked).
      const contract = await client.query(
        `SELECT status FROM marketplace.offtake_contracts WHERE id = $1 FOR UPDATE`,
        [input.contractId]
      );
      const status = contract.rows[0]?.status as string | undefined;
      if (status !== 'active') {
        throw new ConflictException(
          `Offtake contract '${input.contractId}' is '${status ?? 'missing'}'; ` +
            'deliveries record only against an active contract'
        );
      }
      // 2. Exactly-once delivery claim (idempotency key unique).
      const row = offtakeDeliveryMapper.toRow(input.delivery);
      const columns = Object.keys(row);
      const claim = await client.query(
        `INSERT INTO marketplace.offtake_deliveries (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        columns.map((column) => row[column])
      );
      if ((claim.rowCount ?? 0) === 0) {
        // A previous delivery with this key committed; roll back the
        // (empty) transaction and let the caller replay the record.
        throw new OfftakeDeliveryReplay();
      }
      // 3. Reservation verification + finalize (V-50): the caller claimed
      //    the milestone quantity with a guarded CAS BEFORE driving the
      //    payment rails, so this step never adds quantity again — it
      //    proves the reservation is still intact (delivered_qty_kg equals
      //    the reserved total) and finalizes the derived status + evidence
      //    links. Concurrent deliveries serialised at the reservation, so
      //    a mismatch here means the reservation was legitimately unwound.
      const reservedQtyKg = input.milestonePatch.deliveredQtyKg;
      const milestone = await client.query(
        `UPDATE marketplace.offtake_milestones
            SET status = CASE
                           WHEN delivered_qty_kg >= qty_kg THEN 'met'
                           ELSE 'partial'
                         END,
                linked_lot_id = $3,
                invoice_id = $4,
                escrow_id = $5,
                updated_at = now()
          WHERE id = $1
            AND contract_id = $6
            AND status IN ('pending','partial')
            AND delivered_qty_kg = $2
          RETURNING ${MILESTONE_COLUMNS}`,
        [
          input.milestoneId,
          reservedQtyKg,
          input.delivery.lotId,
          input.delivery.invoiceId ?? null,
          input.delivery.escrowId ?? null,
          input.contractId
        ]
      );
      if (!milestone.rows[0]) {
        throw new ConflictException(
          `Offtake milestone '${input.milestoneId}' no longer holds the reserved ` +
            `${reservedQtyKg} kg (met, missed, or the reservation was rolled back)`
        );
      }
      const updatedMilestone = offtakeMilestoneMapper.fromRow(milestone.rows[0]);
      // 4. The balanced escrow-hold journal with the in-transaction
      //    invariant check (any violation rolls the whole step back).
      await postLedgerEntryTx(client, input.entry);
      const balanced = await client.query(
        `SELECT finance.transfer_is_balanced($1) AS balanced`,
        [input.entry.id]
      );
      if (balanced.rows[0]?.balanced !== true) {
        throw new BadRequestException(
          `Offtake delivery journal '${input.entry.id}' failed finance.transfer_is_balanced() — rolled back`
        );
      }
      // 5. Fulfilment CAS: active -> fulfilled only when every milestone met.
      const fulfilled = await client.query(
        `UPDATE marketplace.offtake_contracts
            SET status = 'fulfilled', updated_at = now()
          WHERE id = $1 AND status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM marketplace.offtake_milestones
               WHERE contract_id = $1 AND status <> 'met'
            )
          RETURNING id`,
        [input.contractId]
      );
      // 6. Outbox events derived from the committed state, same transaction.
      const events = input.buildEvents({
        milestone: updatedMilestone,
        fulfilled: (fulfilled.rowCount ?? 0) > 0
      });
      for (const event of events) {
        await appendOutboxTx(client, event);
      }
      return 'applied' as const;
    }).then(
      (applied) => applied,
      (error: unknown) => {
        if (error instanceof OfftakeDeliveryReplay) {
          return 'replay' as const;
        }
        throw error;
      }
    );
  }
}

/** Internal control-flow signal: the delivery idempotency key already exists. */
class OfftakeDeliveryReplay extends Error {
  constructor() {
    super('offtake delivery already committed');
    this.name = 'OfftakeDeliveryReplay';
  }
}

export function createPgOfftakeContractRepository(pool: pg.Pool): PgOfftakeContractRepository {
  return new PgOfftakeContractRepository(pool);
}
