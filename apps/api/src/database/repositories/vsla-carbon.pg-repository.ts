import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type {
  CarbonEvidenceCriteria,
  CarbonEvidenceRecord,
  CarbonEvidenceRepository,
  CarbonEstimateCriteria,
  CarbonEstimateRecord,
  CarbonEstimateRepository,
  CarbonPlotRepository,
  VslaCarbonPlotCriteria,
  VslaCarbonPlotRecord,
  VslaContributionCriteria,
  VslaContributionRecord,
  VslaContributionRepository,
  VslaCycleCriteria,
  VslaCycleRecord,
  VslaCycleRepository,
  VslaGroupCriteria,
  VslaGroupRecord,
  VslaGroupRepository,
  VslaLoanCriteria,
  VslaLoanRecord,
  VslaLoanRepository,
  VslaLoanRepaymentRecord,
  VslaLoanRepaymentRepository,
  VslaMemberCriteria,
  VslaMemberRecord,
  VslaMemberRepository,
  VslaShareOutCriteria,
  VslaShareOutRecord,
  VslaShareOutRepository
} from './vsla-carbon.repository.js';

/**
 * PostgreSQL implementations over the vsla_carbon schema
 * (infra/postgres/037_vsla_carbon.sql). Compare-and-set updates compile
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

export class PgVslaGroupRepository implements VslaGroupRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaGroupRecord): Promise<VslaGroupRecord> {
    await this.pool.query(
      'INSERT INTO vsla_carbon.vsla_groups (id, name, chapter_id, lead_user_id, status, ' +
        'savings_account_code, loans_receivable_account_code, interest_income_account_code, ' +
        'created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        record.id,
        record.name,
        record.chapterId ?? null,
        record.leadUserId,
        record.status,
        record.savingsAccountCode,
        record.loansReceivableAccountCode,
        record.interestIncomeAccountCode,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<VslaGroupRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM vsla_carbon.vsla_groups WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VslaGroupCriteria): Promise<VslaGroupRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.chapterId) {
      params.push(criteria.chapterId);
      where.push(`chapter_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.vsla_groups' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaGroupRecord>,
    expected: Partial<VslaGroupRecord>
  ): Promise<VslaGroupRecord> {
    const columns: Record<string, string> = { status: 'status', updatedAt: 'updated_at' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof VslaGroupRecord]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof VslaGroupRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE vsla_carbon.vsla_groups SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`VSLA group '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as VslaGroupRecord;
  }

  private fromRow(row: Record<string, unknown>): VslaGroupRecord {
    return {
      id: row.id as string,
      name: row.name as string,
      chapterId: (row.chapter_id as string | null) ?? undefined,
      leadUserId: row.lead_user_id as string,
      status: row.status as VslaGroupRecord['status'],
      savingsAccountCode: row.savings_account_code as string,
      loansReceivableAccountCode: row.loans_receivable_account_code as string,
      interestIncomeAccountCode: row.interest_income_account_code as string,
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string
    };
  }
}

export class PgVslaMemberRepository implements VslaMemberRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaMemberRecord): Promise<VslaMemberRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.vsla_members (id, group_id, user_id, role, status, joined_at, exited_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          record.id,
          record.groupId,
          record.userId,
          record.role,
          record.status,
          record.joinedAt,
          record.exitedAt ?? null
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'This user is already a member of the group');
    }
    return record;
  }

  async findById(id: string): Promise<VslaMemberRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM vsla_carbon.vsla_members WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByGroupAndUser(groupId: string, userId: string): Promise<VslaMemberRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM vsla_carbon.vsla_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VslaMemberCriteria): Promise<VslaMemberRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.userId) {
      params.push(criteria.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.vsla_members' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY joined_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaMemberRecord>,
    expected: Partial<VslaMemberRecord>
  ): Promise<VslaMemberRecord> {
    const columns: Record<string, string> = {
      role: 'role',
      status: 'status',
      exitedAt: 'exited_at'
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof VslaMemberRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof VslaMemberRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE vsla_carbon.vsla_members SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`VSLA member '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as VslaMemberRecord;
  }

  private fromRow(row: Record<string, unknown>): VslaMemberRecord {
    return {
      id: row.id as string,
      groupId: row.group_id as string,
      userId: row.user_id as string,
      role: row.role as VslaMemberRecord['role'],
      status: row.status as VslaMemberRecord['status'],
      joinedAt: toIso(row.joined_at) as string,
      exitedAt: toIso(row.exited_at)
    };
  }
}

export class PgVslaCycleRepository implements VslaCycleRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaCycleRecord): Promise<VslaCycleRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.vsla_cycles (id, group_id, label, status, opened_at, closed_at, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          record.id,
          record.groupId,
          record.label,
          record.status,
          record.openedAt,
          record.closedAt ?? null,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'The group already has an open cycle');
    }
    return record;
  }

  async findById(id: string): Promise<VslaCycleRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM vsla_carbon.vsla_cycles WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findOpenByGroup(groupId: string): Promise<VslaCycleRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM vsla_carbon.vsla_cycles WHERE group_id = $1 AND status = 'OPEN'",
      [groupId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VslaCycleCriteria): Promise<VslaCycleRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.vsla_cycles' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY opened_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaCycleRecord>,
    expected: Partial<VslaCycleRecord>
  ): Promise<VslaCycleRecord> {
    const columns: Record<string, string> = { status: 'status', closedAt: 'closed_at' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof VslaCycleRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof VslaCycleRecord] ?? null);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE vsla_carbon.vsla_cycles SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`VSLA cycle '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as VslaCycleRecord;
  }

  private fromRow(row: Record<string, unknown>): VslaCycleRecord {
    return {
      id: row.id as string,
      groupId: row.group_id as string,
      label: row.label as string,
      status: row.status as VslaCycleRecord['status'],
      openedAt: toIso(row.opened_at) as string,
      closedAt: toIso(row.closed_at),
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgVslaContributionRepository implements VslaContributionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaContributionRecord): Promise<VslaContributionRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.vsla_contributions (id, cycle_id, group_id, member_id, amount_kobo, ' +
          'idempotency_key, ledger_entry_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          record.id,
          record.cycleId,
          record.groupId,
          record.memberId,
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

  async findByIdempotencyKey(key: string): Promise<VslaContributionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM vsla_carbon.vsla_contributions WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VslaContributionCriteria): Promise<VslaContributionRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.cycleId) {
      params.push(criteria.cycleId);
      where.push(`cycle_id = $${params.length}`);
    }
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.memberId) {
      params.push(criteria.memberId);
      where.push(`member_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.vsla_contributions' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): VslaContributionRecord {
    return {
      id: row.id as string,
      cycleId: row.cycle_id as string,
      groupId: row.group_id as string,
      memberId: row.member_id as string,
      amountKobo: Number(row.amount_kobo),
      idempotencyKey: row.idempotency_key as string,
      ledgerEntryId: row.ledger_entry_id as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgVslaShareOutRepository implements VslaShareOutRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaShareOutRecord): Promise<VslaShareOutRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.vsla_share_outs (id, cycle_id, member_id, share_kobo, contributed_kobo, ' +
          'residual_kobo, ledger_entry_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          record.id,
          record.cycleId,
          record.memberId,
          record.shareKobo,
          record.contributedKobo,
          record.residualKobo,
          record.ledgerEntryId,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'Share-out already recorded for this member');
    }
    return record;
  }

  async find(criteria: VslaShareOutCriteria): Promise<VslaShareOutRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.cycleId) {
      params.push(criteria.cycleId);
      where.push(`cycle_id = $${params.length}`);
    }
    if (criteria.memberId) {
      params.push(criteria.memberId);
      where.push(`member_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.vsla_share_outs' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): VslaShareOutRecord {
    return {
      id: row.id as string,
      cycleId: row.cycle_id as string,
      memberId: row.member_id as string,
      shareKobo: Number(row.share_kobo),
      contributedKobo: Number(row.contributed_kobo),
      residualKobo: Number(row.residual_kobo),
      ledgerEntryId: row.ledger_entry_id as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgVslaLoanRepository implements VslaLoanRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaLoanRecord): Promise<VslaLoanRecord> {
    await this.pool.query(
      'INSERT INTO vsla_carbon.vsla_loans (id, group_id, cycle_id, member_id, principal_kobo, ' +
        'interest_rate_bps, total_due_kobo, repaid_kobo, status, issued_at, repaid_at, ' +
        'ledger_entry_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        record.id,
        record.groupId,
        record.cycleId,
        record.memberId,
        record.principalKobo,
        record.interestRateBps,
        record.totalDueKobo,
        record.repaidKobo,
        record.status,
        record.issuedAt,
        record.repaidAt ?? null,
        record.ledgerEntryId,
        record.createdAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<VslaLoanRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM vsla_carbon.vsla_loans WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VslaLoanCriteria): Promise<VslaLoanRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.cycleId) {
      params.push(criteria.cycleId);
      where.push(`cycle_id = $${params.length}`);
    }
    if (criteria.memberId) {
      params.push(criteria.memberId);
      where.push(`member_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.vsla_loans' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY issued_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaLoanRecord>,
    expected: Partial<VslaLoanRecord>
  ): Promise<VslaLoanRecord> {
    const columns: Record<string, string> = {
      repaidKobo: 'repaid_kobo',
      status: 'status',
      repaidAt: 'repaid_at'
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof VslaLoanRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof VslaLoanRecord] ?? null);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE vsla_carbon.vsla_loans SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`VSLA loan '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as VslaLoanRecord;
  }

  private fromRow(row: Record<string, unknown>): VslaLoanRecord {
    return {
      id: row.id as string,
      groupId: row.group_id as string,
      cycleId: row.cycle_id as string,
      memberId: row.member_id as string,
      principalKobo: Number(row.principal_kobo),
      interestRateBps: Number(row.interest_rate_bps),
      totalDueKobo: Number(row.total_due_kobo),
      repaidKobo: Number(row.repaid_kobo),
      status: row.status as VslaLoanRecord['status'],
      issuedAt: toIso(row.issued_at) as string,
      repaidAt: toIso(row.repaid_at),
      ledgerEntryId: row.ledger_entry_id as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgVslaLoanRepaymentRepository implements VslaLoanRepaymentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaLoanRepaymentRecord): Promise<VslaLoanRepaymentRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.vsla_loan_repayments (id, loan_id, amount_kobo, idempotency_key, ' +
          'ledger_entry_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          record.id,
          record.loanId,
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

  async findByIdempotencyKey(key: string): Promise<VslaLoanRepaymentRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM vsla_carbon.vsla_loan_repayments WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByLoan(loanId: string): Promise<VslaLoanRepaymentRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM vsla_carbon.vsla_loan_repayments WHERE loan_id = $1 ORDER BY created_at',
      [loanId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): VslaLoanRepaymentRecord {
    return {
      id: row.id as string,
      loanId: row.loan_id as string,
      amountKobo: Number(row.amount_kobo),
      idempotencyKey: row.idempotency_key as string,
      ledgerEntryId: row.ledger_entry_id as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgCarbonPlotRepository implements CarbonPlotRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VslaCarbonPlotRecord): Promise<VslaCarbonPlotRecord> {
    await this.pool.query(
      'INSERT INTO vsla_carbon.carbon_plots (id, group_id, owner_user_id, name, practice_type, ' +
        'hectares_centi, centroid_lat, centroid_long, h3_res9, status, created_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        record.id,
        record.groupId,
        record.ownerUserId,
        record.name,
        record.practiceType,
        record.hectaresCenti,
        record.centroidLat,
        record.centroidLong,
        record.h3Res9,
        record.status,
        record.createdAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<VslaCarbonPlotRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM vsla_carbon.carbon_plots WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VslaCarbonPlotCriteria): Promise<VslaCarbonPlotRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.ownerUserId) {
      params.push(criteria.ownerUserId);
      where.push(`owner_user_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.carbon_plots' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaCarbonPlotRecord>,
    expected: Partial<VslaCarbonPlotRecord>
  ): Promise<VslaCarbonPlotRecord> {
    const columns: Record<string, string> = { status: 'status' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof VslaCarbonPlotRecord]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof VslaCarbonPlotRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE vsla_carbon.carbon_plots SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Carbon plot '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as VslaCarbonPlotRecord;
  }

  private fromRow(row: Record<string, unknown>): VslaCarbonPlotRecord {
    return {
      id: row.id as string,
      groupId: row.group_id as string,
      ownerUserId: row.owner_user_id as string,
      name: row.name as string,
      practiceType: row.practice_type as VslaCarbonPlotRecord['practiceType'],
      hectaresCenti: Number(row.hectares_centi),
      centroidLat: Number(row.centroid_lat),
      centroidLong: Number(row.centroid_long),
      h3Res9: row.h3_res9 as string,
      status: row.status as VslaCarbonPlotRecord['status'],
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgCarbonEvidenceRepository implements CarbonEvidenceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: CarbonEvidenceRecord): Promise<CarbonEvidenceRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.carbon_evidence (id, plot_id, group_id, season, submitted_by, ' +
          'submitter_role, survival_rate_pct, notes, ndvi_health_score, ndvi_classification, ' +
          'ndvi_basis, idempotency_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          record.id,
          record.plotId,
          record.groupId,
          record.season,
          record.submittedBy,
          record.submitterRole,
          record.survivalRatePct ?? null,
          record.notes ?? null,
          record.ndviHealthScore ?? null,
          record.ndviClassification ?? null,
          record.ndviBasis ?? null,
          record.idempotencyKey,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findByIdempotencyKey(key: string): Promise<CarbonEvidenceRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM vsla_carbon.carbon_evidence WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: CarbonEvidenceCriteria): Promise<CarbonEvidenceRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.plotId) {
      params.push(criteria.plotId);
      where.push(`plot_id = $${params.length}`);
    }
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.season) {
      params.push(criteria.season);
      where.push(`season = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.carbon_evidence' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): CarbonEvidenceRecord {
    return {
      id: row.id as string,
      plotId: row.plot_id as string,
      groupId: row.group_id as string,
      season: row.season as string,
      submittedBy: row.submitted_by as string,
      submitterRole: row.submitter_role as CarbonEvidenceRecord['submitterRole'],
      survivalRatePct: row.survival_rate_pct === null ? undefined : Number(row.survival_rate_pct),
      notes: (row.notes as string | null) ?? undefined,
      ndviHealthScore: row.ndvi_health_score === null ? undefined : Number(row.ndvi_health_score),
      ndviClassification: (row.ndvi_classification as string | null) ?? undefined,
      ndviBasis: (row.ndvi_basis as CarbonEvidenceRecord['ndviBasis'] | null) ?? undefined,
      idempotencyKey: row.idempotency_key as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgCarbonEstimateRepository implements CarbonEstimateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: CarbonEstimateRecord): Promise<CarbonEstimateRecord> {
    try {
      await this.pool.query(
        'INSERT INTO vsla_carbon.carbon_estimates (id, plot_id, group_id, season, coefficient_version, ' +
          'hectares_centi, practice_type, survival_rate_pct, season_count, co2e_milli_tonnes, basis, ' +
          'created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          record.id,
          record.plotId,
          record.groupId,
          record.season,
          record.coefficientVersion,
          record.hectaresCenti,
          record.practiceType,
          record.survivalRatePct,
          record.seasonCount,
          record.co2eMilliTonnes,
          record.basis,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'An estimate already exists for this plot and season');
    }
    return record;
  }

  async findByPlotSeasonVersion(
    plotId: string,
    season: string,
    version: string
  ): Promise<CarbonEstimateRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM vsla_carbon.carbon_estimates ' +
        'WHERE plot_id = $1 AND season = $2 AND coefficient_version = $3',
      [plotId, season, version]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: CarbonEstimateCriteria): Promise<CarbonEstimateRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.plotId) {
      params.push(criteria.plotId);
      where.push(`plot_id = $${params.length}`);
    }
    if (criteria.groupId) {
      params.push(criteria.groupId);
      where.push(`group_id = $${params.length}`);
    }
    if (criteria.season) {
      params.push(criteria.season);
      where.push(`season = $${params.length}`);
    }
    const sql =
      'SELECT * FROM vsla_carbon.carbon_estimates' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): CarbonEstimateRecord {
    return {
      id: row.id as string,
      plotId: row.plot_id as string,
      groupId: row.group_id as string,
      season: row.season as string,
      coefficientVersion: row.coefficient_version as string,
      hectaresCenti: Number(row.hectares_centi),
      practiceType: row.practice_type as CarbonEstimateRecord['practiceType'],
      survivalRatePct: Number(row.survival_rate_pct),
      seasonCount: Number(row.season_count),
      co2eMilliTonnes: Number(row.co2e_milli_tonnes),
      basis: 'estimate',
      createdAt: toIso(row.created_at) as string
    };
  }
}

/* ------------------------------ factories ------------------------------ */

export function createPgVslaGroupRepository(pool: pg.Pool): PgVslaGroupRepository {
  return new PgVslaGroupRepository(pool);
}

export function createPgVslaMemberRepository(pool: pg.Pool): PgVslaMemberRepository {
  return new PgVslaMemberRepository(pool);
}

export function createPgVslaCycleRepository(pool: pg.Pool): PgVslaCycleRepository {
  return new PgVslaCycleRepository(pool);
}

export function createPgVslaContributionRepository(pool: pg.Pool): PgVslaContributionRepository {
  return new PgVslaContributionRepository(pool);
}

export function createPgVslaShareOutRepository(pool: pg.Pool): PgVslaShareOutRepository {
  return new PgVslaShareOutRepository(pool);
}

export function createPgVslaLoanRepository(pool: pg.Pool): PgVslaLoanRepository {
  return new PgVslaLoanRepository(pool);
}

export function createPgVslaLoanRepaymentRepository(pool: pg.Pool): PgVslaLoanRepaymentRepository {
  return new PgVslaLoanRepaymentRepository(pool);
}

export function createPgCarbonPlotRepository(pool: pg.Pool): PgCarbonPlotRepository {
  return new PgCarbonPlotRepository(pool);
}

export function createPgCarbonEvidenceRepository(pool: pg.Pool): PgCarbonEvidenceRepository {
  return new PgCarbonEvidenceRepository(pool);
}

export function createPgCarbonEstimateRepository(pool: pg.Pool): PgCarbonEstimateRepository {
  return new PgCarbonEstimateRepository(pool);
}
