import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type { DomainEvent } from '../../core/domain-events.service.js';
import type {
  MerchantPaymentCriteria,
  MerchantPaymentRecord,
  MerchantPaymentRepository,
  MerchantQrCodeCriteria,
  MerchantQrCodeRecord,
  MerchantQrCodeRepository
} from './dealer-qr.repository.js';

/**
 * PostgreSQL implementations over migration 075
 * (agent_banking.merchant_qr_codes / merchant_payments). Compare-and-set
 * updates compile `expected` into WHERE fragments so a lost race updates 0
 * rows → 409, mirroring the in-memory repositories used in unit tests.
 *
 * MerchantPaymentRepository.updateExpected accepts an optional outbox event
 * and appends it to events.outbox in the SAME database transaction as the
 * state change (the transactional-outbox guarantee from the pg base class,
 * hand-rolled here to match the agent-banking pg repositories).
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

export class PgMerchantQrCodeRepository implements MerchantQrCodeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: MerchantQrCodeRecord): Promise<MerchantQrCodeRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.merchant_qr_codes (id, agent_org_id, dealer_user_id, payload_hmac, ' +
          'label, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          record.id,
          record.agentOrgId,
          record.dealerUserId,
          record.payloadHmac,
          record.label,
          record.status,
          record.createdAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<MerchantQrCodeRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.merchant_qr_codes WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: MerchantQrCodeCriteria): Promise<MerchantQrCodeRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.agentOrgId) {
      params.push(criteria.agentOrgId);
      where.push(`agent_org_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.merchant_qr_codes' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<MerchantQrCodeRecord>,
    expected: Partial<MerchantQrCodeRecord>
  ): Promise<MerchantQrCodeRecord> {
    const columns: Record<string, string> = { status: 'status' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof MerchantQrCodeRecord]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof MerchantQrCodeRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.merchant_qr_codes SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : ''),
      params
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Merchant QR code '${id}' changed concurrently; reload and retry`);
    }
    const updated = await this.findById(id);
    return updated as MerchantQrCodeRecord;
  }

  private fromRow(row: Record<string, unknown>): MerchantQrCodeRecord {
    return {
      id: row.id as string,
      agentOrgId: row.agent_org_id as string,
      dealerUserId: row.dealer_user_id as string,
      payloadHmac: row.payload_hmac as string,
      label: row.label as string,
      status: row.status as MerchantQrCodeRecord['status'],
      createdAt: toIso(row.created_at) as string
    };
  }
}

const PAYMENT_COLUMNS: Record<string, string> = {
  status: 'status',
  quoteId: 'quote_id',
  mojaloopTransferId: 'mojaloop_transfer_id',
  ledgerEntryId: 'ledger_entry_id',
  failureReason: 'failure_reason',
  updatedAt: 'updated_at',
  completedAt: 'completed_at'
};

export class PgMerchantPaymentRepository implements MerchantPaymentRepository {
  /** updateExpected persists a passed outbox event in the same transaction. */
  readonly transactionalOutbox = true;

  constructor(private readonly pool: pg.Pool) {}

  async create(record: MerchantPaymentRecord): Promise<MerchantPaymentRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.merchant_payments (id, qr_id, payer_user_id, amount_kobo, ' +
          'voucher_tender_kobo, wallet_tender_kobo, voucher_id, payer_alias_hmac, quote_id, ' +
          'mojaloop_transfer_id, adapter_basis, status, idempotency_key, ledger_entry_id, ' +
          'failure_reason, created_at, updated_at, completed_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
        [
          record.id,
          record.qrId,
          record.payerUserId,
          record.amountKobo,
          record.voucherTenderKobo,
          record.walletTenderKobo,
          record.voucherId ?? null,
          record.payerAliasHmac ?? null,
          record.quoteId ?? null,
          record.mojaloopTransferId ?? null,
          record.adapterBasis,
          record.status,
          record.idempotencyKey ?? null,
          record.ledgerEntryId ?? null,
          record.failureReason ?? null,
          record.createdAt,
          record.updatedAt,
          record.completedAt ?? null
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<MerchantPaymentRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.merchant_payments WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<MerchantPaymentRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.merchant_payments WHERE idempotency_key = $1',
      [key]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async findByTransferId(transferId: string): Promise<MerchantPaymentRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM agent_banking.merchant_payments WHERE mojaloop_transfer_id = $1',
      [transferId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: MerchantPaymentCriteria): Promise<MerchantPaymentRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.qrId) {
      params.push(criteria.qrId);
      where.push(`qr_id = $${params.length}`);
    }
    if (criteria.payerUserId) {
      params.push(criteria.payerUserId);
      where.push(`payer_user_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.merchant_payments' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  /**
   * Compare-and-set with optional transactional outbox: when `outboxEvent`
   * is passed, the state change and the events.outbox append commit in ONE
   * database transaction, eliminating the dual-write window on the
   * settlement path (mirrors PgRepositoryBase.updateExpected).
   */
  async updateExpected(
    id: string,
    patch: Partial<MerchantPaymentRecord>,
    expected: Partial<MerchantPaymentRecord>,
    outboxEvent?: DomainEvent
  ): Promise<MerchantPaymentRecord> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(PAYMENT_COLUMNS)) {
      if (key in patch) {
        params.push(patch[key as keyof MerchantPaymentRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(PAYMENT_COLUMNS)) {
      if (key in expected) {
        params.push(expected[key as keyof MerchantPaymentRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const sql =
      `UPDATE agent_banking.merchant_payments SET ${sets.join(', ')} WHERE id = $1` +
      (where.length > 0 ? ` AND ${where.join(' AND ')}` : '');
    const execute = async (queryable: Pick<pg.Pool, 'query'>): Promise<void> => {
      const result = await queryable.query(sql, params);
      if ((result.rowCount ?? 0) === 0) {
        throw new ConflictException(`Merchant payment '${id}' changed concurrently; reload and retry`);
      }
      if (outboxEvent) {
        await queryable.query(
          'INSERT INTO events.outbox (id, name, payload, actor_id, occurred_at) VALUES ($1, $2, $3, $4, $5)',
          [
            outboxEvent.id,
            outboxEvent.name,
            JSON.stringify(outboxEvent.payload ?? {}),
            outboxEvent.actorId ?? null,
            outboxEvent.occurredAt
          ]
        );
      }
    };
    if (outboxEvent) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await execute(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      await execute(this.pool);
    }
    const updated = await this.findById(id);
    return updated as MerchantPaymentRecord;
  }

  private fromRow(row: Record<string, unknown>): MerchantPaymentRecord {
    return {
      id: row.id as string,
      qrId: row.qr_id as string,
      payerUserId: row.payer_user_id as string,
      amountKobo: Number(row.amount_kobo),
      voucherTenderKobo: Number(row.voucher_tender_kobo),
      walletTenderKobo: Number(row.wallet_tender_kobo),
      voucherId: (row.voucher_id as string) ?? undefined,
      payerAliasHmac: (row.payer_alias_hmac as string) ?? undefined,
      quoteId: (row.quote_id as string) ?? undefined,
      mojaloopTransferId: (row.mojaloop_transfer_id as string) ?? undefined,
      adapterBasis: row.adapter_basis as MerchantPaymentRecord['adapterBasis'],
      status: row.status as MerchantPaymentRecord['status'],
      idempotencyKey: (row.idempotency_key as string) ?? undefined,
      ledgerEntryId: (row.ledger_entry_id as string) ?? undefined,
      failureReason: (row.failure_reason as string) ?? undefined,
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string,
      completedAt: toIso(row.completed_at)
    };
  }
}

export function createPgMerchantQrCodeRepository(pool: pg.Pool): PgMerchantQrCodeRepository {
  return new PgMerchantQrCodeRepository(pool);
}

export function createPgMerchantPaymentRepository(pool: pg.Pool): PgMerchantPaymentRepository {
  return new PgMerchantPaymentRepository(pool);
}
