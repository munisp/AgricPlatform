import { ConflictException, NotFoundException } from '@nestjs/common';
import pg from 'pg';
import type {
  AllocationTx,
  BeneficiaryCriteria,
  BeneficiaryRecord,
  BeneficiaryRepository,
  FundingEventRecord,
  FundingTopUpResult,
  InputVoucherCriteria,
  InputVoucherRecord,
  InputVoucherRepository,
  ProgrammeCriteria,
  ProgrammeFundingRecord,
  ProgrammeFundingRepository,
  RedemptionCriteria,
  RedemptionRecord,
  RedemptionRepository,
  SubsidyProgrammeRecord,
  SubsidyProgrammeRepository
} from './input-vouchers.repository.js';

/**
 * PostgreSQL adapters for the input_vouchers schema (migration 035 — and the
 * stage-23 funded-float tables, migration 046). JSONB columns hold the
 * eligible-state/crop lists; all money columns are bigint kobo.
 *
 * Concurrency contract (stage 22 audit wave):
 *  - updateExpected is a compare-and-set UPDATE ... WHERE id AND <expected>
 *    and throws ConflictException when 0 rows match, so interleaved state
 *    transitions surface as 409 instead of last-write-wins (C2-9).
 *  - withAllocationLock holds SELECT ... FOR UPDATE on the programme row for
 *    the callback's duration, serialising concurrent allocations (C2-10).
 *  - vouchers.idempotency_key / redemptions.voucher_id are UNIQUE; insert
 *    conflicts map 23505 → 409 so retries never double-issue/double-redeem.
 *  - programme_funding moves are single conditional UPDATEs (stage 23, C3);
 *    settle/release are data-modifying CTEs keyed on marker events so a
 *    crash-resume replay applies exactly once.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function toIsoOrUndefined(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : toIso(value);
}

export class PgSubsidyProgrammeRepository implements SubsidyProgrammeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: SubsidyProgrammeRecord): Promise<SubsidyProgrammeRecord> {
    await this.pool.query(
      'INSERT INTO input_vouchers.programmes (id, name, sponsor, description, status, per_farmer_cap_kobo, ' +
        'budget_kobo, eligible_states, eligible_crops, liability_account_code, created_by, created_at, updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        record.id,
        record.name,
        record.sponsor,
        record.description ?? null,
        record.status,
        record.perFarmerCapKobo,
        record.budgetKobo,
        JSON.stringify(record.eligibleStates),
        JSON.stringify(record.eligibleCrops),
        record.liabilityAccountCode,
        record.createdBy,
        record.createdAt,
        record.updatedAt
      ]
    );
    return structuredClone(record);
  }

  async findById(id: string): Promise<SubsidyProgrammeRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.programmes WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: ProgrammeCriteria): Promise<SubsidyProgrammeRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM input_vouchers.programmes${where} ORDER BY created_at`,
      params
    );
    return result.rows.map((row: Row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<SubsidyProgrammeRecord>,
    expected: Partial<SubsidyProgrammeRecord>
  ): Promise<SubsidyProgrammeRecord> {
    const sets: string[] = [];
    const wheres: string[] = ['id = $1'];
    const params: unknown[] = [id];
    const column = this.columnMap();
    for (const [key, value] of Object.entries(patch)) {
      const col = column[key];
      if (!col) {
        continue;
      }
      params.push(col.jsonb ? JSON.stringify(value) : value);
      sets.push(`${col.name} = $${params.length}`);
    }
    for (const [key, value] of Object.entries(expected)) {
      const col = column[key];
      if (!col) {
        continue;
      }
      params.push(value);
      wheres.push(`${col.name} = $${params.length}`);
    }
    if (sets.length === 0) {
      const current = await this.findById(id);
      if (!current) {
        throw new NotFoundException(`Programme '${id}' not found`);
      }
      return current;
    }
    const result = await this.pool.query(
      `UPDATE input_vouchers.programmes SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')} RETURNING *`,
      params
    );
    if (result.rowCount === 0) {
      throw new ConflictException(`Programme '${id}' changed concurrently; reload and retry`);
    }
    return this.fromRow(result.rows[0]);
  }

  /**
   * Allocation serialisation (stage 22, audit C2-10): locks the programme row
   * (SELECT ... FOR UPDATE) inside a transaction for the callback's duration
   * so a concurrent allocation for the same programme waits until this
   * check+insert finishes — two 60% allocations can no longer both pass the
   * budget check. Transaction style mirrors ledger.pg-repository.postEntry.
   *
   * Stage 24 (audit A4-2): the callback receives the transaction client so
   * the conditional float-reserve UPDATE and the voucher INSERT run on THIS
   * connection — reserve + create commit together or roll back together.
   * Before this change they autocommitted on other pool connections, so a
   * post-commit failure could unreserve the backing of a LIVE voucher.
   */
  async withAllocationLock<T>(programmeId: string, fn: (tx?: AllocationTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM input_vouchers.programmes WHERE id = $1 FOR UPDATE', [
        programmeId
      ]);
      const result = await fn(client as unknown as AllocationTx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private columnMap(): Record<string, { name: string; jsonb?: boolean }> {
    return {
      name: { name: 'name' },
      sponsor: { name: 'sponsor' },
      description: { name: 'description' },
      status: { name: 'status' },
      perFarmerCapKobo: { name: 'per_farmer_cap_kobo' },
      budgetKobo: { name: 'budget_kobo' },
      eligibleStates: { name: 'eligible_states', jsonb: true },
      eligibleCrops: { name: 'eligible_crops', jsonb: true },
      liabilityAccountCode: { name: 'liability_account_code' },
      updatedAt: { name: 'updated_at' }
    };
  }

  private fromRow(row: Row): SubsidyProgrammeRecord {
    return {
      id: row.id,
      name: row.name,
      sponsor: row.sponsor,
      description: row.description ?? undefined,
      status: row.status,
      perFarmerCapKobo: Number(row.per_farmer_cap_kobo),
      budgetKobo: Number(row.budget_kobo),
      eligibleStates: row.eligible_states ?? [],
      eligibleCrops: row.eligible_crops ?? [],
      liabilityAccountCode: row.liability_account_code,
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at)
    };
  }
}

export class PgBeneficiaryRepository implements BeneficiaryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: BeneficiaryRecord): Promise<BeneficiaryRecord> {
    try {
      await this.pool.query(
        'INSERT INTO input_vouchers.beneficiaries (id, programme_id, farmer_id, nin_hash, nin_mask, ' +
          'verification_basis, name_match_score, state, primary_crop, verified_at, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          record.id,
          record.programmeId,
          record.farmerId,
          record.ninHash,
          record.ninMask,
          record.verificationBasis,
          record.nameMatchScore ?? null,
          record.state ?? null,
          record.primaryCrop ?? null,
          record.verifiedAt,
          record.createdAt
        ]
      );
    } catch (error) {
      this.rethrowUnique(error, 'This farmer or NIN is already enrolled in the programme');
    }
    return structuredClone(record);
  }

  async findById(id: string): Promise<BeneficiaryRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.beneficiaries WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByProgrammeAndFarmer(
    programmeId: string,
    farmerId: string
  ): Promise<BeneficiaryRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.beneficiaries WHERE programme_id = $1 AND farmer_id = $2',
      [programmeId, farmerId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.programmeId) {
      params.push(criteria.programmeId);
      clauses.push(`programme_id = $${params.length}`);
    }
    if (criteria.farmerId) {
      params.push(criteria.farmerId);
      clauses.push(`farmer_id = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM input_vouchers.beneficiaries${where} ORDER BY created_at`,
      params
    );
    return result.rows.map((row: Row) => this.fromRow(row));
  }

  private rethrowUnique(error: unknown, message: string): never {
    if ((error as { code?: string }).code === '23505') {
      throw new ConflictException(message);
    }
    throw error;
  }

  private fromRow(row: Row): BeneficiaryRecord {
    return {
      id: row.id,
      programmeId: row.programme_id,
      farmerId: row.farmer_id,
      ninHash: row.nin_hash,
      ninMask: row.nin_mask,
      verificationBasis: row.verification_basis,
      nameMatchScore: row.name_match_score === null ? undefined : Number(row.name_match_score),
      state: row.state ?? undefined,
      primaryCrop: row.primary_crop ?? undefined,
      verifiedAt: toIso(row.verified_at),
      createdAt: toIso(row.created_at)
    };
  }
}

export class PgInputVoucherRepository implements InputVoucherRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: InputVoucherRecord, tx?: AllocationTx): Promise<InputVoucherRecord> {
    try {
      await (tx ?? this.pool).query(
        'INSERT INTO input_vouchers.vouchers (id, programme_id, beneficiary_id, farmer_id, amount_kobo, ' +
          'status, idempotency_key, expires_at, distributed_at, redeemed_at, voided_at, ledger_entry_id, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          record.id,
          record.programmeId,
          record.beneficiaryId,
          record.farmerId,
          record.amountKobo,
          record.status,
          record.idempotencyKey,
          record.expiresAt,
          record.distributedAt ?? null,
          record.redeemedAt ?? null,
          record.voidedAt ?? null,
          record.ledgerEntryId ?? null,
          record.createdAt
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('A record with these unique values already exists');
      }
      throw error;
    }
    return structuredClone(record);
  }

  async findById(id: string): Promise<InputVoucherRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.vouchers WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<InputVoucherRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.vouchers WHERE idempotency_key = $1', [
      key
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: InputVoucherCriteria): Promise<InputVoucherRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.programmeId) {
      params.push(criteria.programmeId);
      clauses.push(`programme_id = $${params.length}`);
    }
    if (criteria.beneficiaryId) {
      params.push(criteria.beneficiaryId);
      clauses.push(`beneficiary_id = $${params.length}`);
    }
    if (criteria.farmerId) {
      params.push(criteria.farmerId);
      clauses.push(`farmer_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM input_vouchers.vouchers${where} ORDER BY created_at`,
      params
    );
    return result.rows.map((row: Row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<InputVoucherRecord>,
    expected: Partial<InputVoucherRecord>
  ): Promise<InputVoucherRecord> {
    const sets: string[] = [];
    const wheres: string[] = ['id = $1'];
    const params: unknown[] = [id];
    const column = this.columnMap();
    for (const [key, value] of Object.entries(patch)) {
      const col = column[key];
      if (!col) {
        continue;
      }
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    }
    for (const [key, value] of Object.entries(expected)) {
      const col = column[key];
      if (!col) {
        continue;
      }
      params.push(value);
      wheres.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) {
      const current = await this.findById(id);
      if (!current) {
        throw new NotFoundException(`Voucher '${id}' not found`);
      }
      return current;
    }
    const result = await this.pool.query(
      `UPDATE input_vouchers.vouchers SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')} RETURNING *`,
      params
    );
    if (result.rowCount === 0) {
      throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
    }
    return this.fromRow(result.rows[0]);
  }

  private columnMap(): Record<string, string> {
    return {
      status: 'status',
      distributedAt: 'distributed_at',
      redeemedAt: 'redeemed_at',
      voidedAt: 'voided_at',
      ledgerEntryId: 'ledger_entry_id'
    };
  }

  private fromRow(row: Row): InputVoucherRecord {
    return {
      id: row.id,
      programmeId: row.programme_id,
      beneficiaryId: row.beneficiary_id,
      farmerId: row.farmer_id,
      amountKobo: Number(row.amount_kobo),
      status: row.status,
      idempotencyKey: row.idempotency_key,
      expiresAt: toIso(row.expires_at),
      distributedAt: toIsoOrUndefined(row.distributed_at),
      redeemedAt: toIsoOrUndefined(row.redeemed_at),
      voidedAt: toIsoOrUndefined(row.voided_at),
      ledgerEntryId: row.ledger_entry_id ?? undefined,
      createdAt: toIso(row.created_at)
    };
  }
}

export class PgRedemptionRepository implements RedemptionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: RedemptionRecord): Promise<RedemptionRecord> {
    try {
      await this.pool.query(
        'INSERT INTO input_vouchers.redemptions (id, voucher_id, programme_id, supplier_id, invoice_ref, ' +
          'amount_kobo, idempotency_key, ledger_entry_id, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          record.id,
          record.voucherId,
          record.programmeId,
          record.supplierId,
          record.invoiceRef,
          record.amountKobo,
          record.idempotencyKey,
          record.ledgerEntryId,
          record.createdAt
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        if (String((error as { constraint?: string }).constraint).includes('voucher_id')) {
          throw new ConflictException(`Voucher '${record.voucherId}' has already been redeemed`);
        }
        throw new ConflictException('A record with these unique values already exists');
      }
      throw error;
    }
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<RedemptionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.redemptions WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: RedemptionCriteria): Promise<RedemptionRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.voucherId) {
      params.push(criteria.voucherId);
      clauses.push(`voucher_id = $${params.length}`);
    }
    if (criteria.programmeId) {
      params.push(criteria.programmeId);
      clauses.push(`programme_id = $${params.length}`);
    }
    if (criteria.supplierId) {
      params.push(criteria.supplierId);
      clauses.push(`supplier_id = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM input_vouchers.redemptions${where} ORDER BY created_at`,
      params
    );
    return result.rows.map((row: Row) => this.fromRow(row));
  }

  private fromRow(row: Row): RedemptionRecord {
    return {
      id: row.id,
      voucherId: row.voucher_id,
      programmeId: row.programme_id,
      supplierId: row.supplier_id,
      invoiceRef: row.invoice_ref,
      amountKobo: Number(row.amount_kobo),
      idempotencyKey: row.idempotency_key,
      ledgerEntryId: row.ledger_entry_id,
      createdAt: toIso(row.created_at)
    };
  }
}

/**
 * pg funded-float store (stage 23, audit C3). Every move is ONE statement:
 *  - reserve: conditional UPDATE that moves 0 rows when the float cannot
    * back the voucher (the row lock on programme_funding serialises racers);
 *  - settle/release: data-modifying CTEs that INSERT the marker event first
 *   (ON CONFLICT idempotency_key ⇒ the loser moves NOTHING) and only then
 *   apply the funding move — exactly-once per voucher under crash-resume
 *   and concurrent retry, with no read-then-write window.
 */
export class PgProgrammeFundingRepository implements ProgrammeFundingRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getFunding(programmeId: string): Promise<ProgrammeFundingRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.programme_funding WHERE programme_id = $1',
      [programmeId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async creditTopUp(event: FundingEventRecord): Promise<FundingTopUpResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO input_vouchers.programme_funding_events ' +
          '(id, programme_id, kind, amount_kobo, idempotency_key, reference, created_by, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *',
        [
          event.id,
          event.programmeId,
          event.kind,
          event.amountKobo,
          event.idempotencyKey,
          event.reference ?? null,
          event.createdBy,
          event.createdAt
        ]
      );
      let record: FundingEventRecord;
      let replayed: boolean;
      if (inserted.rows[0]) {
        record = this.eventFromRow(inserted.rows[0]);
        replayed = false;
      } else {
        const existing = await client.query(
          'SELECT * FROM input_vouchers.programme_funding_events WHERE idempotency_key = $1',
          [event.idempotencyKey]
        );
        const original = existing.rows[0] ? this.eventFromRow(existing.rows[0]) : undefined;
        // Stage 24 (audit A4-9): same idempotency key + different payload is
        // a client bug on a money endpoint — 409, never a silent replay
        // (payout-rail payload-hash doctrine).
        if (
          original &&
          (original.programmeId !== event.programmeId ||
            original.kind !== event.kind ||
            original.amountKobo !== event.amountKobo)
        ) {
          throw new ConflictException(
            `Idempotency key '${event.idempotencyKey}' was already used with a different funding payload`
          );
        }
        record = original as FundingEventRecord;
        replayed = true;
      }
      let funding: ProgrammeFundingRecord;
      if (!replayed) {
        // INSERT the funding row on first top-up; credit on later ones.
        const upserted = await client.query(
          'INSERT INTO input_vouchers.programme_funding (programme_id, funded_kobo, reserved_kobo, settled_kobo, updated_at) ' +
            'VALUES ($1, $2, 0, 0, now()) ' +
            'ON CONFLICT (programme_id) DO UPDATE SET funded_kobo = input_vouchers.programme_funding.funded_kobo + $2, updated_at = now() ' +
            'RETURNING *',
          [event.programmeId, event.amountKobo]
        );
        funding = this.fromRow(upserted.rows[0]);
      } else {
        const current = await client.query(
          'SELECT * FROM input_vouchers.programme_funding WHERE programme_id = $1',
          [event.programmeId]
        );
        funding = this.fromRow(current.rows[0]);
      }
      await client.query('COMMIT');
      return { event: record, funding, replayed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reserve(programmeId: string, amountKobo: number, tx?: AllocationTx): Promise<boolean> {
    const result = await (tx ?? this.pool).query(
      'UPDATE input_vouchers.programme_funding ' +
        'SET reserved_kobo = reserved_kobo + $1, updated_at = now() ' +
        'WHERE programme_id = $2 AND funded_kobo - reserved_kobo - settled_kobo >= $1 ' +
        'RETURNING programme_id',
      [amountKobo, programmeId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async unreserve(programmeId: string, amountKobo: number): Promise<void> {
    await this.pool.query(
      'UPDATE input_vouchers.programme_funding ' +
        'SET reserved_kobo = reserved_kobo - $1, updated_at = now() ' +
        'WHERE programme_id = $2 AND reserved_kobo >= $1',
      [amountKobo, programmeId]
    );
  }

  async settleReserved(programmeId: string, amountKobo: number, markerKey: string, actorId: string): Promise<void> {
    await this.applyMarker(programmeId, amountKobo, markerKey, actorId, 'settle');
  }

  async releaseReserved(programmeId: string, amountKobo: number, markerKey: string, actorId: string): Promise<void> {
    await this.applyMarker(programmeId, amountKobo, markerKey, actorId, 'release');
  }

  /**
   * One-statement exactly-once marker + move. The marker INSERT wins or
   * no-ops; the funding UPDATE fires only for the row that won the insert,
   * so a concurrent duplicate (or a crash-resume replay after the commit)
   * moves nothing. The funding move itself is conditional on the backing
   * reservation still existing (legacy pre-046 vouchers have none — the
   * marker still records the attempt, matching the idempotent-no-op
   * semantics the in-memory adapter documents).
   */
  private async applyMarker(
    programmeId: string,
    amountKobo: number,
    markerKey: string,
    actorId: string,
    kind: 'settle' | 'release'
  ): Promise<void> {
    const settleDelta = kind === 'settle' ? amountKobo : 0;
    await this.pool.query(
      'WITH ins AS ( ' +
        'INSERT INTO input_vouchers.programme_funding_events ' +
        '(id, programme_id, kind, amount_kobo, idempotency_key, reference, created_by, created_at) ' +
        `VALUES ($1, $2, '${kind}', $3, $4, $5, now()) ` +
        // Stage 24 (audit A4-10 pg contract): the marker id IS the marker
        // key, so a conflict can surface on the PRIMARY KEY as well as the
        // idempotency_key UNIQUE index — a constraint-targeted clause would
        // let the twin fail with 23505 instead of skipping. Targetless ON
        // CONFLICT blocks the twin until the winner commits, then skips.
        'ON CONFLICT DO NOTHING RETURNING id' +
        ') ' +
        'UPDATE input_vouchers.programme_funding f ' +
        'SET reserved_kobo = f.reserved_kobo - $3, settled_kobo = f.settled_kobo + $6, updated_at = now() ' +
        'FROM ins ' +
        'WHERE f.programme_id = $2 AND f.reserved_kobo >= $3',
      [markerKey, programmeId, amountKobo, markerKey, actorId, settleDelta]
    );
  }

  private fromRow(row: Row): ProgrammeFundingRecord {
    return {
      programmeId: row.programme_id,
      fundedKobo: Number(row.funded_kobo),
      reservedKobo: Number(row.reserved_kobo),
      settledKobo: Number(row.settled_kobo),
      updatedAt: toIso(row.updated_at)
    };
  }

  private eventFromRow(row: Row): FundingEventRecord {
    return {
      id: row.id,
      programmeId: row.programme_id,
      kind: row.kind,
      amountKobo: Number(row.amount_kobo),
      idempotencyKey: row.idempotency_key,
      reference: row.reference ?? undefined,
      createdBy: row.created_by,
      createdAt: toIso(row.created_at)
    };
  }
}

export function createPgSubsidyProgrammeRepository(pool: pg.Pool): PgSubsidyProgrammeRepository {
  return new PgSubsidyProgrammeRepository(pool);
}

export function createPgBeneficiaryRepository(pool: pg.Pool): PgBeneficiaryRepository {
  return new PgBeneficiaryRepository(pool);
}

export function createPgInputVoucherRepository(pool: pg.Pool): PgInputVoucherRepository {
  return new PgInputVoucherRepository(pool);
}

export function createPgRedemptionRepository(pool: pg.Pool): PgRedemptionRepository {
  return new PgRedemptionRepository(pool);
}

export function createPgProgrammeFundingRepository(pool: pg.Pool): PgProgrammeFundingRepository {
  return new PgProgrammeFundingRepository(pool);
}
