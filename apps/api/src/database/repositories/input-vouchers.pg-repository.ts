import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type {
  BeneficiaryCriteria,
  BeneficiaryRecord,
  BeneficiaryRepository,
  InputVoucherCriteria,
  InputVoucherRecord,
  InputVoucherRepository,
  ProgrammeCriteria,
  RedemptionRecord,
  RedemptionRepository,
  SubsidyProgrammeRecord,
  SubsidyProgrammeRepository
} from './input-vouchers.repository.js';

/**
 * PostgreSQL implementations over the input_vouchers schema
 * (infra/postgres/035_input_vouchers.sql). Compare-and-set updates compile
 * `expected` into WHERE fragments so a lost race updates 0 rows → 409,
 * mirroring the in-memory repositories used in unit tests.
 */

function assertPgUnique(error: unknown, message: string): never {
  if ((error as { code?: string }).code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

function toIso(value: unknown): string | undefined {
  return value === null || value === undefined
    ? undefined
    : new Date(value as string).toISOString();
}

export class PgSubsidyProgrammeRepository implements SubsidyProgrammeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: SubsidyProgrammeRecord): Promise<SubsidyProgrammeRecord> {
    await this.pool.query(
      'INSERT INTO input_vouchers.programmes (id, name, input_type, sponsor_name, budget_kobo, ' +
        'per_farmer_cap_kobo, status, liability_account_code, ledger_entry_id, starts_at, ends_at, ' +
        'created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [
        record.id,
        record.name,
        record.inputType,
        record.sponsorName,
        record.budgetKobo,
        record.perFarmerCapKobo,
        record.status,
        record.liabilityAccountCode,
        record.ledgerEntryId ?? null,
        record.startsAt ?? null,
        record.endsAt ?? null,
        record.createdBy,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<SubsidyProgrammeRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.programmes WHERE id = $1', [
      id
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: ProgrammeCriteria): Promise<SubsidyProgrammeRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM input_vouchers.programmes' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  /**
   * Allocation serialisation (stage 22, audit C2-10): locks the programme row
   * (SELECT ... FOR UPDATE) inside a transaction for the callback's duration
   * so a concurrent allocation for the same programme waits until this
   * check+insert finishes — two 60% allocations can no longer both pass the
   * budget check. Transaction style mirrors ledger.pg-repository.postEntry.
   */
  async withAllocationLock<T>(programmeId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM input_vouchers.programmes WHERE id = $1 FOR UPDATE', [
        programmeId
      ]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateExpected(
    id: string,
    patch: Partial<SubsidyProgrammeRecord>,
    expected: Partial<SubsidyProgrammeRecord>
  ): Promise<SubsidyProgrammeRecord> {
    const columns: Record<string, string> = { status: 'status', updatedAt: 'updated_at' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof SubsidyProgrammeRecord]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof SubsidyProgrammeRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE input_vouchers.programmes SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Programme '${id}' changed concurrently; reload and retry`);
    }
    const updated = await this.findById(id);
    return updated as SubsidyProgrammeRecord;
  }

  private fromRow(row: Record<string, unknown>): SubsidyProgrammeRecord {
    return {
      id: row.id as string,
      name: row.name as string,
      inputType: row.input_type as string,
      sponsorName: row.sponsor_name as string,
      budgetKobo: Number(row.budget_kobo),
      perFarmerCapKobo: Number(row.per_farmer_cap_kobo),
      status: row.status as SubsidyProgrammeRecord['status'],
      liabilityAccountCode: row.liability_account_code as string,
      ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
      startsAt: toIso(row.starts_at),
      endsAt: toIso(row.ends_at),
      createdBy: row.created_by as string,
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string
    };
  }
}

export class PgBeneficiaryRepository implements BeneficiaryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: BeneficiaryRecord): Promise<BeneficiaryRecord> {
    try {
      await this.pool.query(
        'INSERT INTO input_vouchers.beneficiaries (id, farmer_id, programme_id, nin_hash, nin_mask, ' +
          'verification_status, verification_basis, verified_at, verified_by, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          record.id,
          record.farmerId,
          record.programmeId,
          record.ninHash,
          record.ninMask,
          record.verificationStatus,
          record.verificationBasis,
          record.verifiedAt,
          record.verifiedBy,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'This NIN is already enrolled in the programme');
    }
    return record;
  }

  async findById(id: string): Promise<BeneficiaryRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.beneficiaries WHERE id = $1', [
      id
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.programmeId) {
      params.push(criteria.programmeId);
      where.push(`programme_id = $${params.length}`);
    }
    if (criteria.farmerId) {
      params.push(criteria.farmerId);
      where.push(`farmer_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM input_vouchers.beneficiaries' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async findByProgrammeAndNinHash(
    programmeId: string,
    ninHash: string
  ): Promise<BeneficiaryRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.beneficiaries WHERE programme_id = $1 AND nin_hash = $2',
      [programmeId, ninHash]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  private fromRow(row: Record<string, unknown>): BeneficiaryRecord {
    return {
      id: row.id as string,
      farmerId: row.farmer_id as string,
      programmeId: row.programme_id as string,
      ninHash: row.nin_hash as string,
      ninMask: row.nin_mask as string,
      verificationStatus: row.verification_status as BeneficiaryRecord['verificationStatus'],
      verificationBasis: row.verification_basis as BeneficiaryRecord['verificationBasis'],
      verifiedAt: toIso(row.verified_at) as string,
      verifiedBy: row.verified_by as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgInputVoucherRepository implements InputVoucherRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: InputVoucherRecord): Promise<InputVoucherRecord> {
    try {
      await this.pool.query(
        'INSERT INTO input_vouchers.vouchers (id, programme_id, beneficiary_id, farmer_id, ' +
          'amount_kobo, status, idempotency_key, expires_at, distributed_at, redeemed_at, ' +
          'voided_at, ledger_entry_id, created_at) ' +
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
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<InputVoucherRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.vouchers WHERE id = $1', [
      id
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<InputVoucherRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.vouchers WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: InputVoucherCriteria): Promise<InputVoucherRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.programmeId) {
      params.push(criteria.programmeId);
      where.push(`programme_id = $${params.length}`);
    }
    if (criteria.farmerId) {
      params.push(criteria.farmerId);
      where.push(`farmer_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM input_vouchers.vouchers' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<InputVoucherRecord>,
    expected: Partial<InputVoucherRecord>
  ): Promise<InputVoucherRecord> {
    const columns: Record<string, string> = {
      status: 'status',
      distributedAt: 'distributed_at',
      redeemedAt: 'redeemed_at',
      voidedAt: 'voided_at',
      ledgerEntryId: 'ledger_entry_id'
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof InputVoucherRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof InputVoucherRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE input_vouchers.vouchers SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
    }
    const updated = await this.findById(id);
    return updated as InputVoucherRecord;
  }

  private fromRow(row: Record<string, unknown>): InputVoucherRecord {
    return {
      id: row.id as string,
      programmeId: row.programme_id as string,
      beneficiaryId: row.beneficiary_id as string,
      farmerId: row.farmer_id as string,
      amountKobo: Number(row.amount_kobo),
      status: row.status as InputVoucherRecord['status'],
      idempotencyKey: row.idempotency_key as string,
      expiresAt: toIso(row.expires_at) as string,
      distributedAt: toIso(row.distributed_at),
      redeemedAt: toIso(row.redeemed_at),
      voidedAt: toIso(row.voided_at),
      ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgRedemptionRepository implements RedemptionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: RedemptionRecord): Promise<RedemptionRecord> {
    try {
      await this.pool.query(
        'INSERT INTO input_vouchers.redemptions (id, voucher_id, programme_id, supplier_id, ' +
          'invoice_ref, amount_kobo, idempotency_key, ledger_entry_id, created_at) ' +
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
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findByIdempotencyKey(key: string): Promise<RedemptionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.redemptions WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByVoucherId(voucherId: string): Promise<RedemptionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.redemptions WHERE voucher_id = $1',
      [voucherId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByProgrammeId(programmeId: string): Promise<RedemptionRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM input_vouchers.redemptions WHERE programme_id = $1 ORDER BY created_at',
      [programmeId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): RedemptionRecord {
    return {
      id: row.id as string,
      voucherId: row.voucher_id as string,
      programmeId: row.programme_id as string,
      supplierId: row.supplier_id as string,
      invoiceRef: row.invoice_ref as string,
      amountKobo: Number(row.amount_kobo),
      idempotencyKey: row.idempotency_key as string,
      ledgerEntryId: row.ledger_entry_id as string,
      createdAt: toIso(row.created_at) as string
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
