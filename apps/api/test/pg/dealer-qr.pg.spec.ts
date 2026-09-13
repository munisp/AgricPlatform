import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import type {
  MerchantPaymentRecord,
  MerchantQrCodeRecord
} from '../../src/database/repositories/dealer-qr.repository.js';
import {
  PgMerchantPaymentRepository,
  PgMerchantQrCodeRepository
} from '../../src/database/repositories/dealer-qr.pg-repository.js';
import type { DomainEvent } from '../../src/core/domain-events.service.js';

/**
 * Dealer QR Pay pg contract (Stage 27, Innovation 16; migration 075).
 *
 * Two layers, mirroring the 047/052/073 pg patterns:
 *  - `pg dealer qr pay (query spy)`: always-on tests over a fake pool
 *    proving the INSERT column order, the CAS WHERE compilation, the
 *    23505 → 409 unique-violation mapping (UNIQUE mojaloop_transfer_id is
 *    the settlement idempotency key), and the single-transaction
 *    state-change + outbox append on the settlement CAS.
 *  - `pg dealer qr pay (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style, exercised by CI's db-contract
 *    job against a database with migrations through 075 applied: the
 *    UNIQUE transfer id rejects a second settlement row for the same
 *    switch transfer (webhook redelivery cannot double-settle), the
 *    partial idempotency index replays client retries, and the co-pay
 *    split CHECK pins voucher + wallet = amount in integer kobo.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const query = async (text: string, params?: unknown[]) => {
    calls.push({ text, params: params ?? [] });
    const outcome = behavior(text, params ?? []);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return {
      rows: outcome.rows,
      rowCount: outcome.rowCount ?? outcome.rows.length,
      command: 'UPDATE',
      oid: 0,
      fields: []
    };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined })
  } as unknown as pg.Pool;
  return { pool, calls };
}

function paymentTemplate(overrides: Partial<MerchantPaymentRecord> = {}): MerchantPaymentRecord {
  return {
    id: 'mpay-1',
    qrId: 'qr-1',
    payerUserId: 'user-farmer',
    amountKobo: 100_000,
    voucherTenderKobo: 40_000,
    walletTenderKobo: 60_000,
    voucherId: 'voucher-1',
    payerAliasHmac: 'a'.repeat(64),
    adapterBasis: 'live',
    status: 'quoted',
    idempotencyKey: 'pay-key-1',
    createdAt: '2026-01-18T23:00:00.000Z',
    updatedAt: '2026-01-18T23:00:00.000Z',
    ...overrides
  };
}

function paymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mpay-1',
    qr_id: 'qr-1',
    payer_user_id: 'user-farmer',
    amount_kobo: '100000',
    voucher_tender_kobo: '40000',
    wallet_tender_kobo: '60000',
    voucher_id: 'voucher-1',
    payer_alias_hmac: 'a'.repeat(64),
    quote_id: 'quote-mpay-1',
    mojaloop_transfer_id: 'transfer-mpay-1',
    adapter_basis: 'live',
    status: 'completed',
    idempotency_key: 'pay-key-1',
    ledger_entry_id: 'entry-1',
    failure_reason: null,
    created_at: '2026-01-18T23:00:00.000Z',
    updated_at: '2026-01-18T23:30:00.000Z',
    completed_at: '2026-01-18T23:30:00.000Z',
    ...overrides
  };
}

function qrTemplate(overrides: Partial<MerchantQrCodeRecord> = {}): MerchantQrCodeRecord {
  return {
    id: 'qr-1',
    agentOrgId: 'agent-1',
    dealerUserId: 'user-dealer',
    payloadHmac: 'b'.repeat(64),
    label: 'Kano shop',
    status: 'active',
    createdAt: '2026-01-18T23:00:00.000Z',
    ...overrides
  };
}

describe('pg dealer qr pay (query spy)', () => {
  it('payment INSERT covers every persisted column in table order', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    await new PgMerchantPaymentRepository(pool).create(paymentTemplate());
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO agent_banking.merchant_payments');
    expect(calls[0].params).toEqual([
      'mpay-1',
      'qr-1',
      'user-farmer',
      100_000,
      40_000,
      60_000,
      'voucher-1',
      'a'.repeat(64),
      null,
      null,
      'live',
      'quoted',
      'pay-key-1',
      null,
      null,
      '2026-01-18T23:00:00.000Z',
      '2026-01-18T23:00:00.000Z',
      null
    ]);
  });

  it('maps 23505 on create to 409 (UNIQUE transfer id / idempotency key)', async () => {
    const { pool } = fakePool(() => Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(new PgMerchantPaymentRepository(pool).create(paymentTemplate())).rejects.toThrow(
      ConflictException
    );
    await expect(
      new PgMerchantQrCodeRepository(
        fakePool(() => Object.assign(new Error('duplicate key'), { code: '23505' })).pool
      ).create(qrTemplate())
    ).rejects.toThrow(ConflictException);
  });

  it('settlement CAS compiles the quoted guard and commits the outbox event in ONE transaction', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 1 }));
    const event: DomainEvent = {
      id: 'event-1',
      name: 'agent_banking.merchant_payment.completed',
      payload: { paymentId: 'mpay-1', tenantId: 'user:user-farmer' },
      actorId: 'user-farmer',
      occurredAt: '2026-01-18T23:30:00.000Z'
    };
    await new PgMerchantPaymentRepository(pool).updateExpected(
      'mpay-1',
      { status: 'completed', ledgerEntryId: 'entry-1', completedAt: '2026-01-18T23:30:00.000Z' },
      { status: 'quoted' },
      event
    );
    const texts = calls.map((call) => call.text);
    expect(texts[0]).toBe('BEGIN');
    const update = calls.find((call) => call.text.startsWith('UPDATE agent_banking.merchant_payments'));
    expect(update?.text).toContain('WHERE id = $1 AND status = $');
    expect(update?.params).toContain('quoted');
    const outbox = calls.find((call) => call.text.startsWith('INSERT INTO events.outbox'));
    expect(outbox?.params).toEqual([
      'event-1',
      'agent_banking.merchant_payment.completed',
      JSON.stringify({ paymentId: 'mpay-1', tenantId: 'user:user-farmer' }),
      'user-farmer',
      '2026-01-18T23:30:00.000Z'
    ]);
    expect(texts[texts.length - 2]).toBe('COMMIT');
  });

  it('CAS conflict (0 rows) surfaces as 409', async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await expect(
      new PgMerchantPaymentRepository(pool).updateExpected('mpay-1', { status: 'completed' }, { status: 'quoted' })
    ).rejects.toThrow(ConflictException);
  });

  it('transfer-id lookup targets the UNIQUE settlement key column', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [paymentRow()] }));
    const found = await new PgMerchantPaymentRepository(pool).findByTransferId('transfer-mpay-1');
    expect(calls[0].text).toContain('WHERE mojaloop_transfer_id = $1');
    expect(found?.status).toBe('completed');
    expect(found?.amountKobo).toBe(100_000);
    expect(found?.voucherTenderKobo + (found?.walletTenderKobo ?? 0)).toBe(found?.amountKobo);
  });

  it('QR round-trip maps snake_case columns and ISO timestamps', async () => {
    const row = {
      id: 'qr-1',
      agent_org_id: 'agent-1',
      dealer_user_id: 'user-dealer',
      payload_hmac: 'b'.repeat(64),
      label: 'Kano shop',
      status: 'active',
      created_at: '2026-01-18T23:00:00.000Z'
    };
    const { pool } = fakePool(() => ({ rows: [row] }));
    const found = await new PgMerchantQrCodeRepository(pool).findById('qr-1');
    expect(found).toEqual(qrTemplate());
  });
});

// --------------------------------------------------------------- live ----

const describePg = describe.skipIf(!process.env.DATABASE_URL);

describePg('pg dealer qr pay (live)', () => {
  async function livePool(): Promise<pg.Pool> {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('SELECT 1');
    return pool;
  }

  async function seedPrerequisites(pool: pg.Pool): Promise<{ qrId: string }> {
    await pool.query(
      "INSERT INTO identity.users (id, phone, full_name) VALUES ('user-dqr-dealer','+2348001000001','Dealer QR Live') ON CONFLICT (id) DO NOTHING"
    );
    await pool.query(
      "INSERT INTO identity.users (id, phone, full_name) VALUES ('user-dqr-farmer','+2348001000002','Farmer QR Live') ON CONFLICT (id) DO NOTHING"
    );
    await pool.query(
      "INSERT INTO agent_banking.agents (id, user_id, organisation, status, float_account_code, commission_account_code, daily_limit_kobo) " +
        "VALUES ('agent-dqr-live','user-dqr-dealer','QR Live Org','ACTIVE','agent:agent-dqr-live:float','agent:agent-dqr-live:commission_payable',25000000) ON CONFLICT (id) DO NOTHING"
    );
    const qrId = `qr-live-${Date.now()}`;
    await pool.query(
      "INSERT INTO agent_banking.merchant_qr_codes (id, agent_org_id, dealer_user_id, payload_hmac, label) VALUES ($1,'agent-dqr-live','user-dqr-dealer',$2,'live shop')",
      [qrId, 'c'.repeat(64)]
    );
    return { qrId };
  }

  it('UNIQUE(mojaloop_transfer_id) rejects a second settlement row for the same switch transfer', async () => {
    const pool = await livePool();
    try {
      const { qrId } = await seedPrerequisites(pool);
      const repo = new PgMerchantPaymentRepository(pool);
      const base = paymentTemplate({ id: `mpay-live-${Date.now()}-a`, qrId, mojaloopTransferId: `tr-${Date.now()}` });
      await repo.create(base);
      await expect(
        repo.create(paymentTemplate({ id: `${base.id}-b`, qrId, mojaloopTransferId: base.mojaloopTransferId, idempotencyKey: 'other-key' }))
      ).rejects.toThrow(ConflictException);
    } finally {
      await pool.end();
    }
  });

  it('the quoted→completed CAS makes a redelivered webhook settlement a no-op (second CAS wins 0 rows)', async () => {
    const pool = await livePool();
    try {
      const { qrId } = await seedPrerequisites(pool);
      const repo = new PgMerchantPaymentRepository(pool);
      const id = `mpay-live-${Date.now()}-cas`;
      await repo.create(paymentTemplate({ id, qrId, idempotencyKey: `key-${id}` }));
      const first = await repo.updateExpected(id, { status: 'completed' }, { status: 'quoted' });
      expect(first.status).toBe('completed');
      await expect(
        repo.updateExpected(id, { status: 'completed' }, { status: 'quoted' })
      ).rejects.toThrow(ConflictException);
    } finally {
      await pool.end();
    }
  });

  it('the split CHECK rejects voucher + wallet != amount', async () => {
    const pool = await livePool();
    try {
      const { qrId } = await seedPrerequisites(pool);
      await expect(
        pool.query(
          "INSERT INTO agent_banking.merchant_payments (id, qr_id, payer_user_id, amount_kobo, voucher_tender_kobo, wallet_tender_kobo, adapter_basis, status) " +
            "VALUES ($1,$2,'user-dqr-farmer',100000,40000,50000,'live','quoted')",
          [`mpay-live-${Date.now()}-split`, qrId]
        )
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});
