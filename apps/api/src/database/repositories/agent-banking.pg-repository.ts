import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type {
  AgentBankingAgentRepository,
  AgentCriteria,
  AgentDeviceRecord,
  AgentDeviceRepository,
  AgentFloatTopUpRecord,
  AgentFloatTopUpRepository,
  AgentRecord,
  AgentReversalRecord,
  AgentReversalRepository,
  AgentReversalStatus,
  AgentTopUpCriteria,
  AgentTransactionCriteria,
  AgentTransactionRecord,
  AgentTransactionRepository,
  AgentVoucherCriteria,
  AgentVoucherRecord,
  AgentVoucherRepository
} from './agent-banking.repository.js';

/**
 * PostgreSQL implementations over the agent_banking schema
 * (infra/postgres/032_agent_banking.sql). Compare-and-set updates compile
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

export class PgAgentBankingAgentRepository implements AgentBankingAgentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentRecord): Promise<AgentRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.agents (id, user_id, organisation, status, float_account_code, ' +
          'commission_account_code, daily_limit_kobo, low_float_threshold_kobo, created_at, updated_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          record.id,
          record.userId,
          record.organisation,
          record.status,
          record.floatAccountCode,
          record.commissionAccountCode,
          record.dailyLimitKobo,
          record.lowFloatThresholdKobo,
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'This user is already registered as an agent');
    }
    return record;
  }

  async findById(id: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.agents WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByUserId(userId: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.agents WHERE user_id = $1', [
      userId
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: AgentCriteria): Promise<AgentRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    if (criteria.userId) {
      params.push(criteria.userId);
      where.push(`user_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.agents' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentRecord>,
    expected: Partial<AgentRecord>
  ): Promise<AgentRecord> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const columns: Record<string, string> = {
      status: 'status',
      dailyLimitKobo: 'daily_limit_kobo',
      lowFloatThresholdKobo: 'low_float_threshold_kobo',
      updatedAt: 'updated_at',
      // W2-C2 (V-40, migration 103): close-out bookkeeping
      deregisteredAt: 'deregistered_at',
      voucherGraceUntil: 'voucher_grace_until',
      deregistrationReason: 'deregistration_reason'
    };
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof AgentRecord]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof AgentRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.agents SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Agent '${id}' changed concurrently; reload and retry`);
    }
    const updated = await this.findById(id);
    return updated as AgentRecord;
  }

  private fromRow(row: Record<string, unknown>): AgentRecord {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      organisation: row.organisation as string,
      status: row.status as AgentRecord['status'],
      floatAccountCode: row.float_account_code as string,
      commissionAccountCode: row.commission_account_code as string,
      dailyLimitKobo: Number(row.daily_limit_kobo),
      lowFloatThresholdKobo: Number(row.low_float_threshold_kobo),
      deregisteredAt: toIso(row.deregistered_at),
      voucherGraceUntil: toIso(row.voucher_grace_until),
      deregistrationReason: (row.deregistration_reason as string) ?? undefined,
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string
    };
  }
}

export class PgAgentFloatTopUpRepository implements AgentFloatTopUpRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentFloatTopUpRecord): Promise<AgentFloatTopUpRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.float_topups (id, agent_id, amount_kobo, status, requested_by, ' +
          'decided_by, decided_at, settled_at, ledger_entry_id, rejection_reason, idempotency_key, ' +
          'payload_hash, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          record.id,
          record.agentId,
          record.amountKobo,
          record.status,
          record.requestedBy,
          record.decidedBy ?? null,
          record.decidedAt ?? null,
          record.settledAt ?? null,
          record.ledgerEntryId ?? null,
          record.rejectionReason ?? null,
          record.idempotencyKey ?? null,
          record.payloadHash ?? null,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<AgentFloatTopUpRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.float_topups WHERE id = $1', [
      id
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<AgentFloatTopUpRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.float_topups WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: AgentTopUpCriteria): Promise<AgentFloatTopUpRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.agentId) {
      params.push(criteria.agentId);
      where.push(`agent_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.float_topups' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentFloatTopUpRecord>,
    expected: Partial<AgentFloatTopUpRecord>
  ): Promise<AgentFloatTopUpRecord> {
    const columns: Record<string, string> = {
      status: 'status',
      decidedBy: 'decided_by',
      decidedAt: 'decided_at',
      settledAt: 'settled_at',
      ledgerEntryId: 'ledger_entry_id',
      rejectionReason: 'rejection_reason'
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof AgentFloatTopUpRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof AgentFloatTopUpRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.float_topups SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Float top-up '${id}' changed concurrently; reload and retry`);
    }
    const updated = await this.findById(id);
    return updated as AgentFloatTopUpRecord;
  }

  private fromRow(row: Record<string, unknown>): AgentFloatTopUpRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      amountKobo: Number(row.amount_kobo),
      status: row.status as AgentFloatTopUpRecord['status'],
      requestedBy: row.requested_by as string,
      decidedBy: (row.decided_by as string) ?? undefined,
      decidedAt: toIso(row.decided_at),
      settledAt: toIso(row.settled_at),
      ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
      rejectionReason: (row.rejection_reason as string) ?? undefined,
      idempotencyKey: (row.idempotency_key as string) ?? undefined,
      payloadHash: (row.payload_hash as string) ?? undefined,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgAgentVoucherRepository implements AgentVoucherRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentVoucherRecord): Promise<AgentVoucherRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.vouchers (id, agent_id, farmer_id, amount_kobo, expires_at, nonce, ' +
          'signature, status, redeemed_at, ledger_entry_id, idempotency_key, payload_hash, created_at, ' +
          'issuance_ledger_entry_id) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          record.id,
          record.agentId,
          record.farmerId,
          record.amountKobo,
          record.expiresAt,
          record.nonce,
          record.signature,
          record.status,
          record.redeemedAt ?? null,
          record.ledgerEntryId ?? null,
          record.idempotencyKey ?? null,
          record.payloadHash ?? null,
          record.createdAt,
          record.issuanceLedgerEntryId ?? null
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<AgentVoucherRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.vouchers WHERE id = $1', [
      id
    ]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<AgentVoucherRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.vouchers WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: AgentVoucherCriteria): Promise<AgentVoucherRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.agentId) {
      params.push(criteria.agentId);
      where.push(`agent_id = $${params.length}`);
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
      'SELECT * FROM agent_banking.vouchers' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentVoucherRecord>,
    expected: Partial<AgentVoucherRecord>
  ): Promise<AgentVoucherRecord> {
    const columns: Record<string, string> = {
      status: 'status',
      redeemedAt: 'redeemed_at',
      ledgerEntryId: 'ledger_entry_id',
      // W2-C2 (V-33, migration 101): liability lifecycle
      settleLedgerEntryId: 'settle_ledger_entry_id',
      refundStatus: 'refund_status',
      refundLedgerEntryId: 'refund_ledger_entry_id',
      refundedAt: 'refunded_at'
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof AgentVoucherRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    if (expected.status) {
      params.push(expected.status);
      where.push(`status = $${params.length}`);
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.vouchers SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
    }
    const updated = await this.findById(id);
    return updated as AgentVoucherRecord;
  }

  private fromRow(row: Record<string, unknown>): AgentVoucherRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      farmerId: row.farmer_id as string,
      amountKobo: Number(row.amount_kobo),
      expiresAt: toIso(row.expires_at) as string,
      nonce: row.nonce as string,
      signature: row.signature as string,
      status: row.status as AgentVoucherRecord['status'],
      redeemedAt: toIso(row.redeemed_at),
      ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
      idempotencyKey: (row.idempotency_key as string) ?? undefined,
      payloadHash: (row.payload_hash as string) ?? undefined,
      issuanceLedgerEntryId: (row.issuance_ledger_entry_id as string) ?? undefined,
      settleLedgerEntryId: (row.settle_ledger_entry_id as string) ?? undefined,
      refundStatus: (row.refund_status as AgentVoucherRecord['refundStatus']) ?? undefined,
      refundLedgerEntryId: (row.refund_ledger_entry_id as string) ?? undefined,
      refundedAt: toIso(row.refunded_at),
      createdAt: toIso(row.created_at) as string
    };
  }
}

export class PgAgentTransactionRepository implements AgentTransactionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentTransactionRecord): Promise<AgentTransactionRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.transactions (id, agent_id, farmer_id, type, amount_kobo, ' +
          'commission_kobo, idempotency_key, ledger_entry_id, voucher_id, otp_basis, payload_hash, created_at, ' +
          'reversal_of_transaction_id, fraud_case_id) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          record.id,
          record.agentId,
          record.farmerId,
          record.type,
          record.amountKobo,
          record.commissionKobo,
          record.idempotencyKey,
          record.ledgerEntryId,
          record.voucherId ?? null,
          record.otpBasis ?? null,
          record.payloadHash ?? null,
          record.createdAt,
          record.reversalOfTransactionId ?? null,
          record.fraudCaseId ?? null
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<AgentTransactionRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.transactions WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<AgentTransactionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.transactions WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: AgentTransactionCriteria): Promise<AgentTransactionRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.agentId) {
      params.push(criteria.agentId);
      where.push(`agent_id = $${params.length}`);
    }
    if (criteria.farmerId) {
      params.push(criteria.farmerId);
      where.push(`farmer_id = $${params.length}`);
    }
    if (criteria.type) {
      params.push(criteria.type);
      where.push(`type = $${params.length}`);
    }
    if (criteria.voucherId) {
      params.push(criteria.voucherId);
      where.push(`voucher_id = $${params.length}`);
    }
    if (criteria.from) {
      params.push(criteria.from);
      where.push(`created_at >= $${params.length}`);
    }
    if (criteria.to) {
      params.push(criteria.to);
      where.push(`created_at <= $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.transactions' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): AgentTransactionRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      farmerId: row.farmer_id as string,
      type: row.type as AgentTransactionRecord['type'],
      amountKobo: Number(row.amount_kobo),
      commissionKobo: Number(row.commission_kobo),
      idempotencyKey: row.idempotency_key as string,
      ledgerEntryId: row.ledger_entry_id as string,
      voucherId: (row.voucher_id as string) ?? undefined,
      otpBasis: (row.otp_basis as AgentTransactionRecord['otpBasis']) ?? undefined,
      payloadHash: (row.payload_hash as string) ?? undefined,
      reversalOfTransactionId: (row.reversal_of_transaction_id as string) ?? undefined,
      fraudCaseId: (row.fraud_case_id as string) ?? undefined,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export function createPgAgentBankingAgentRepository(pool: pg.Pool): PgAgentBankingAgentRepository {
  return new PgAgentBankingAgentRepository(pool);
}

export function createPgAgentFloatTopUpRepository(pool: pg.Pool): PgAgentFloatTopUpRepository {
  return new PgAgentFloatTopUpRepository(pool);
}

export function createPgAgentVoucherRepository(pool: pg.Pool): PgAgentVoucherRepository {
  return new PgAgentVoucherRepository(pool);
}

export function createPgAgentTransactionRepository(pool: pg.Pool): PgAgentTransactionRepository {
  return new PgAgentTransactionRepository(pool);
}

/** W2-C2 (V-41, migration 104): agent device bindings (hashed tokens only). */
export class PgAgentDeviceRepository implements AgentDeviceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentDeviceRecord): Promise<AgentDeviceRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.devices (id, agent_id, device_token_hash, label, status, bound_by, ' +
          'revoked_by, revoked_at, revoke_reason, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          record.id,
          record.agentId,
          record.deviceTokenHash,
          record.label ?? null,
          record.status,
          record.boundBy,
          record.revokedBy ?? null,
          record.revokedAt ?? null,
          record.revokeReason ?? null,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'This device is already bound to the agent');
    }
    return record;
  }

  async findByAgentAndHash(agentId: string, deviceTokenHash: string): Promise<AgentDeviceRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.devices WHERE agent_id = $1 AND device_token_hash = $2',
      [agentId, deviceTokenHash]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findById(id: string): Promise<AgentDeviceRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.devices WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByAgent(agentId: string): Promise<AgentDeviceRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.devices WHERE agent_id = $1 ORDER BY created_at',
      [agentId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentDeviceRecord>,
    expected: { status: AgentDeviceRecord['status'] }
  ): Promise<AgentDeviceRecord> {
    const columns: Record<string, string> = {
      status: 'status',
      revokedBy: 'revoked_by',
      revokedAt: 'revoked_at',
      revokeReason: 'revoke_reason',
      label: 'label'
    };
    const sets: string[] = [];
    const params: unknown[] = [id, expected.status];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof AgentDeviceRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.devices SET ${sets.join(', ')} WHERE id = $1 AND status = $2`,
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Device '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as AgentDeviceRecord;
  }

  private fromRow(row: Record<string, unknown>): AgentDeviceRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      deviceTokenHash: row.device_token_hash as string,
      label: (row.label as string) ?? undefined,
      status: row.status as AgentDeviceRecord['status'],
      boundBy: row.bound_by as string,
      revokedBy: (row.revoked_by as string) ?? undefined,
      revokedAt: toIso(row.revoked_at),
      revokeReason: (row.revoke_reason as string) ?? undefined,
      createdAt: toIso(row.created_at) as string
    };
  }
}

/** W2-C2 (V-08, migration 102): maker-checker reversal requests. */
export class PgAgentReversalRepository implements AgentReversalRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentReversalRecord): Promise<AgentReversalRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.reversals (id, agent_id, transaction_id, amount_kobo, reason, fraud_case_id, ' +
          'status, initiated_by, decided_by, decided_at, ledger_entry_id, reversal_transaction_id, idempotency_key, created_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          record.id,
          record.agentId,
          record.transactionId,
          record.amountKobo,
          record.reason,
          record.fraudCaseId ?? null,
          record.status,
          record.initiatedBy,
          record.decidedBy ?? null,
          record.decidedAt ?? null,
          record.ledgerEntryId ?? null,
          record.reversalTransactionId ?? null,
          record.idempotencyKey,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A reversal for this transaction (or idempotency key) already exists');
    }
    return record;
  }

  async findById(id: string): Promise<AgentReversalRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.reversals WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<AgentReversalRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.reversals WHERE idempotency_key = $1', [key]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findLiveByTransaction(transactionId: string): Promise<AgentReversalRecord | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM agent_banking.reversals WHERE transaction_id = $1 AND status IN ('PENDING', 'APPROVED', 'POSTED')",
      [transactionId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByAgent(agentId: string): Promise<AgentReversalRecord[]> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.reversals WHERE agent_id = $1 ORDER BY created_at',
      [agentId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<AgentReversalRecord>,
    expected: { status: AgentReversalStatus }
  ): Promise<AgentReversalRecord> {
    const columns: Record<string, string> = {
      status: 'status',
      decidedBy: 'decided_by',
      decidedAt: 'decided_at',
      ledgerEntryId: 'ledger_entry_id',
      reversalTransactionId: 'reversal_transaction_id'
    };
    const sets: string[] = [];
    const params: unknown[] = [id, expected.status];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof AgentReversalRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.reversals SET ${sets.join(', ')} WHERE id = $1 AND status = $2`,
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Reversal '${id}' changed concurrently; reload and retry`);
    }
    return (await this.findById(id)) as AgentReversalRecord;
  }

  private fromRow(row: Record<string, unknown>): AgentReversalRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      transactionId: row.transaction_id as string,
      amountKobo: Number(row.amount_kobo),
      reason: row.reason as string,
      fraudCaseId: (row.fraud_case_id as string) ?? undefined,
      status: row.status as AgentReversalRecord['status'],
      initiatedBy: row.initiated_by as string,
      decidedBy: (row.decided_by as string) ?? undefined,
      decidedAt: toIso(row.decided_at),
      ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
      reversalTransactionId: (row.reversal_transaction_id as string) ?? undefined,
      idempotencyKey: row.idempotency_key as string,
      createdAt: toIso(row.created_at) as string
    };
  }
}

export function createPgAgentDeviceRepository(pool: pg.Pool): PgAgentDeviceRepository {
  return new PgAgentDeviceRepository(pool);
}

export function createPgAgentReversalRepository(pool: pg.Pool): PgAgentReversalRepository {
  return new PgAgentReversalRepository(pool);
}
