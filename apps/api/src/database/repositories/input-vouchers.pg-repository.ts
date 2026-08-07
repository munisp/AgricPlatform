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
  RedemptionCriteria,
  RedemptionRecord,
  RedemptionRepository,
  SubsidyProgrammeRecord,
  SubsidyProgrammeRepository
} from './input-vouchers.repository.js';

/**
 * PostgreSQL implementations over the input_vouchers schema
 * (infra/postgres/035_input_vouchers.sql). Compare-and-set updates compile
 * `expected` into WHERE fragments so a lost race updates 0 rows → 409,
 * mirroring the in-memory repositories used in unit tests. jsonb columns
 * (eligible_states / eligible_crops) are serialised explicitly — node-pg
 * would otherwise encode JS arrays as Postgres array literals, which do
 * not cast to jsonb.
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

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as string[];
  }
  return [];
}

export class PgSubsidyProgrammeRepository implements SubsidyProgrammeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: SubsidyProgrammeRecord): Promise<SubsidyProgrammeRecord> {
    await this.pool.query(
      'INSERT INTO input_vouchers.programmes (id, name, sponsor, description, status, ' +
        'per_farmer_cap_kobo, budget_kobo, eligible_states, eligible_crops, ' +
        'liability_account_code, created_by, created_at, updated_at) ' +
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
    return record;
  }

  async findById(id: string): Promise<SubsidyProgrammeRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.programmes WHERE id = $1', [id]);
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
      sponsor: row.sponsor as string,
      description: (row.description as string) ?? undefined,
      status: row.status as SubsidyProgrammeRecord['status'],
      perFarmerCapKobo: Number(row.per_farmer_cap_kobo),
      budgetKobo: Number(row.budget_kobo),
      eligibleStates: toStringArray(row.eligible_states),
      eligibleCrops: toStringArray(row.eligible_crops),
      liabilityAccountCode: row.liability_account_code as string,
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
      assertPgUnique(error, 'This farmer or NIN is already enrolled in the programme');
    }
    return record;
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

  private fromRow(row: Record<string, unknown>): BeneficiaryRecord {
    return {
      id: row.id as string,
      programmeId: row.programme_id as string,
      farmerId: row.farmer_id as string,
      ninHash: row.nin_hash as string,
      ninMask: row.nin_mask as string,
      verificationBasis: row.verification_basis as BeneficiaryRecord['verificationBasis'],
      nameMatchScore:
        row.name_match_score === null || row.name_match_score === undefined
          ? undefined
          : Number(row.name_match_score),
      state: (row.state as string) ?? undefined,
      primaryCrop: (row.primary_crop as string) ?? undefined,
      verifiedAt: toIso(row.verified_at) as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgInputVoucherRepository implements InputVoucherRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: InputVoucherRecord): Promise<InputVoucherRecord> {
    try {
      await this.pool.query(
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
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<InputVoucherRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM input_vouchers.vouchers WHERE id = $1', [id]);
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
    if (criteria.beneficiaryId) {
      params.push(criteria.beneficiaryId);
      where.push(`beneficiary_id = $${params.length}`);
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
        params.push(expected[key as keyof InputVoucherRecord] ?? null);
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
      assertPgUnique(error, `Voucher '${record.voucherId}' has already been redeemed`);
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

  async find(criteria: RedemptionCriteria): Promise<RedemptionRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.voucherId) {
      params.push(criteria.voucherId);
      where.push(`voucher_id = $${params.length}`);
    }
    if (criteria.programmeId) {
      params.push(criteria.programmeId);
      where.push(`programme_id = $${params.length}`);
    }
    if (criteria.supplierId) {
      params.push(criteria.supplierId);
      where.push(`supplier_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM input_vouchers.redemptions' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
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
