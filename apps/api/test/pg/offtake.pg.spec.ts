import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import type { OfftakeDelivery } from '../../src/modules/marketplace/offtake.js';
import { PgOfftakeContractRepository } from '../../src/database/repositories/offtake.pg-repository.js';

/**
 * Harvest Forward Contracts pg contract (Stage 27, Innovation 18; migration
 * 077_offtake_contracts.sql).
 *
 * Two layers, mirroring the 052 escrow-payout-claim patterns:
 *  - `pg offtake delivery saga (query spy)`: always-on tests over a fake
 *    pool proving the single-transaction saga compiles to (1) a FOR UPDATE
 *    contract lock, (2) an ON CONFLICT exactly-once delivery claim, (3) ONE
 *    guarded accumulation UPDATE whose preconditions pin status and prevent
 *    overshoot, (4) the balanced-journal invariant check, and (5) the
 *    fulfilment CAS + outbox appends — all inside BEGIN..COMMIT.
 *  - `pg offtake contract (live)`: skipped unless DATABASE_URL points at a
 *    database with migrations applied; exercises the CHECK constraints
 *    (window, price band, delivered <= qty), UNIQUE (contract_id, seq) and
 *    the saga replay semantics against real PostgreSQL.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

const MILESTONE_ROW = {
  id: 'offms-1',
  contract_id: 'offtake-1',
  seq: 1,
  due_date: '2027-06-30',
  qty_kg: 2_000,
  delivered_qty_kg: 1_000,
  linked_lot_id: 'lot-1',
  invoice_id: 'invoice-1',
  escrow_id: 'escrow-1',
  status: 'partial',
  created_at: new Date('2027-03-10T00:00:00Z'),
  updated_at: new Date('2027-03-10T00:00:00Z')
};

function deliveryRow(): OfftakeDelivery {
  return {
    id: 'offdel-1',
    contractId: 'offtake-1',
    milestoneId: 'offms-1',
    lotId: 'lot-1',
    orderId: 'order-1',
    invoiceId: 'invoice-1',
    escrowId: 'escrow-1',
    qtyKg: 1_000,
    priceKoboPerKg: 50_000,
    amountKobo: 50_000_000,
    ledgerEntryId: '2c1f2a58-0000-4000-8000-000000000001',
    idempotencyKey: 'pg-del-key-1',
    createdBy: 'user-coop',
    createdAt: '2027-03-10T00:00:00.000Z'
  };
}

function journalEntry(): LedgerJournalEntry {
  return {
    id: '2c1f2a58-0000-4000-8000-000000000001',
    idempotencyKey: 'offtake-delivery:pg-del-key-1',
    referenceType: 'offtake_delivery',
    referenceId: 'offdel-1',
    postedAt: '2027-03-10T00:00:00.000Z',
    postings: [
      { accountCode: 'org:user-buyer:offtake_escrow', direction: 'debit', amountKobo: 50_000_000 },
      { accountCode: 'offtake:offtake-1:escrow_liability', direction: 'credit', amountKobo: 50_000_000 }
    ]
  };
}

function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
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
    },
    release: () => undefined
  } as unknown as pg.PoolClient;
  const pool = {
    connect: async () => client,
    query: client.query
  } as unknown as pg.Pool;
  return { pool, calls };
}

function sagaBehavior(text: string): QueryOutcome {
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
    return { rows: [] };
  }
  if (text.includes('FROM marketplace.offtake_contracts') && text.includes('FOR UPDATE')) {
    return { rows: [{ status: 'active' }] };
  }
  if (text.includes('INSERT INTO marketplace.offtake_deliveries')) {
    return { rows: [{ id: 'offdel-1' }], rowCount: 1 };
  }
  if (text.includes('UPDATE marketplace.offtake_milestones')) {
    return { rows: [MILESTONE_ROW], rowCount: 1 };
  }
  if (text.includes('FROM finance.ledger_accounts')) {
    return { rows: [{ id: '2c1f2a58-0000-4000-8000-000000000099' }] };
  }
  if (text.includes('finance.transfer_is_balanced')) {
    return { rows: [{ balanced: true }] };
  }
  if (text.includes('UPDATE marketplace.offtake_contracts')) {
    return { rows: [], rowCount: 0 }; // not fulfilled
  }
  return { rows: [] };
}

function sagaInput() {
  return {
    contractId: 'offtake-1',
    milestoneId: 'offms-1',
    delivery: deliveryRow(),
    milestonePatch: {
      deliveredQtyKg: 1_000,
      status: 'partial' as const,
      linkedLotId: 'lot-1',
      invoiceId: 'invoice-1',
      escrowId: 'escrow-1'
    },
    entry: journalEntry(),
    buildEvents: () => [
      {
        id: 'event-1',
        name: 'marketplace.offtake.delivery_recorded',
        payload: { contractId: 'offtake-1' },
        actorId: 'user-coop',
        occurredAt: '2027-03-10T00:00:00.000Z'
      }
    ]
  };
}

describe('pg offtake delivery saga (query spy)', () => {
  it('locks the contract, claims exactly once and accumulates with ONE guarded UPDATE', async () => {
    const { pool, calls } = fakePool(sagaBehavior);
    const repo = new PgOfftakeContractRepository(pool);
    const outcome = await repo.recordDeliveryTx(sagaInput());
    expect(outcome).toBe('applied');
    const texts = calls.map((call) => call.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[texts.length - 1]).toBe('COMMIT');
    // Contract re-verified under a row lock.
    expect(texts.some((text) => text.includes('FOR UPDATE'))).toBe(true);
    // Exactly-once delivery claim on the idempotency key.
    const claim = texts.find((text) => text.includes('INSERT INTO marketplace.offtake_deliveries'));
    expect(claim).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    // ONE accumulation UPDATE with the status precondition and overshoot guard.
    const accumulation = texts.filter((text) => text.includes('UPDATE marketplace.offtake_milestones'));
    expect(accumulation).toHaveLength(1);
    expect(accumulation[0]).toContain('delivered_qty_kg + $2');
    expect(accumulation[0]).toContain("status IN ('pending','partial')");
    expect(accumulation[0]).toContain('delivered_qty_kg + $2 <= qty_kg');
    // The balanced-journal invariant is checked in the same transaction.
    expect(texts.some((text) => text.includes('finance.transfer_is_balanced'))).toBe(true);
    // The outbox event is appended inside the transaction (before COMMIT).
    const outboxIndex = texts.findIndex((text) => text.includes('INSERT INTO events.outbox'));
    expect(outboxIndex).toBeGreaterThan(-1);
    expect(outboxIndex).toBeLessThan(texts.length - 1);
  });

  it('answers replay when the idempotency key was already committed (nothing re-posted)', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('INSERT INTO marketplace.offtake_deliveries')) {
        return { rows: [], rowCount: 0 }; // claim lost: already committed
      }
      return sagaBehavior(text);
    });
    const repo = new PgOfftakeContractRepository(pool);
    const outcome = await repo.recordDeliveryTx(sagaInput());
    expect(outcome).toBe('replay');
    const texts = calls.map((call) => call.text);
    expect(texts.some((text) => text.includes('UPDATE marketplace.offtake_milestones'))).toBe(false);
    expect(texts.some((text) => text.includes('INSERT INTO finance.ledger_transfers'))).toBe(false);
    expect(texts[texts.length - 1]).toBe('ROLLBACK');
  });

  it('rolls the whole step back when the journal fails the balanced invariant', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('finance.transfer_is_balanced')) {
        return { rows: [{ balanced: false }] };
      }
      return sagaBehavior(text);
    });
    const repo = new PgOfftakeContractRepository(pool);
    await expect(repo.recordDeliveryTx(sagaInput())).rejects.toThrow(/transfer_is_balanced/);
    const texts = calls.map((call) => call.text);
    expect(texts[texts.length - 1]).toBe('ROLLBACK');
  });
});

// ---------------------------------------------------------------------------
// Live contract tests (CI db-contract job): CHECKs, UNIQUE, saga replay.
// ---------------------------------------------------------------------------

const describePg = describe.skipIf(!process.env.DATABASE_URL);

const livePool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = ['001_init.sql', '003_commerce_finance.sql', '077_offtake_contracts.sql'].map(
  (file) => join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

async function clean(): Promise<void> {
  await livePool!.query(`DELETE FROM events.outbox WHERE id LIKE 'pgtest-off-%'`);
  await livePool!.query(`DELETE FROM finance.ledger_entries WHERE transfer_id IN (
    SELECT id FROM finance.ledger_transfers WHERE idempotency_key LIKE 'pgtest-off-%')`);
  await livePool!.query(`DELETE FROM finance.ledger_transfers WHERE idempotency_key LIKE 'pgtest-off-%'`);
  await livePool!.query(`DELETE FROM finance.ledger_accounts WHERE code LIKE 'pgtest-off-%'`);
  await livePool!.query(`DELETE FROM marketplace.offtake_deliveries WHERE id LIKE 'pgtest-off-%'`);
  await livePool!.query(`DELETE FROM marketplace.offtake_milestones WHERE id LIKE 'pgtest-off-%'`);
  await livePool!.query(`DELETE FROM marketplace.offtake_contracts WHERE id LIKE 'pgtest-off-%'`);
}

const CONTRACT_ROW = {
  id: 'pgtest-off-contract-1',
  cooperative_id: 'pgtest-off-coop',
  buyer_org_id: 'pgtest-off-buyer',
  commodity: 'maize',
  qty_kg: 2_000,
  quality_spec: '{}',
  price_band: '{"floorKoboPerKg":40000,"capKoboPerKg":60000}',
  window_start: '2027-01-01',
  window_end: '2027-12-31',
  status: 'draft',
  created_by: 'pgtest-off-coop'
};

async function insertContract(overrides: Record<string, unknown> = {}): Promise<void> {
  const row = { ...CONTRACT_ROW, ...overrides };
  await livePool!.query(
    `INSERT INTO marketplace.offtake_contracts
       (id, cooperative_id, buyer_org_id, commodity, qty_kg, quality_spec, price_band,
        window_start, window_end, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.id,
      row.cooperative_id,
      row.buyer_org_id,
      row.commodity,
      row.qty_kg,
      row.quality_spec,
      row.price_band,
      row.window_start,
      row.window_end,
      row.status,
      row.created_by
    ]
  );
}

describePg('pg offtake contract (live)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await livePool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
  });

  afterAll(async () => {
    if (livePool) {
      await clean();
      await livePool.end();
    }
  });

  it('applies migration 077 idempotently', async () => {
    const migration = readFileSync(MIGRATIONS[2], 'utf8');
    await livePool!.query(migration);
    await livePool!.query(migration); // second application is a no-op
  });

  it('rejects inverted delivery windows (CHECK window_end > window_start)', async () => {
    await expect(
      insertContract({ id: 'pgtest-off-contract-badwindow', window_start: '2027-12-31', window_end: '2027-01-01' })
    ).rejects.toThrow(/window_end/);
  });

  it('rejects invalid price bands (CHECK floor > 0, cap >= floor)', async () => {
    await expect(
      insertContract({ id: 'pgtest-off-contract-zerofloor', price_band: '{"floorKoboPerKg":0,"capKoboPerKg":100}' })
    ).rejects.toThrow(/price_band/);
    await expect(
      insertContract({ id: 'pgtest-off-contract-invertedband', price_band: '{"floorKoboPerKg":60000,"capKoboPerKg":40000}' })
    ).rejects.toThrow(/price_band/);
  });

  it('enforces UNIQUE (contract_id, seq) and delivered_qty_kg <= qty_kg', async () => {
    await insertContract();
    const milestone = {
      id: 'pgtest-off-ms-1',
      contract_id: CONTRACT_ROW.id,
      seq: 1,
      due_date: '2027-06-30',
      qty_kg: 2_000
    };
    await livePool!.query(
      `INSERT INTO marketplace.offtake_milestones (id, contract_id, seq, due_date, qty_kg)
       VALUES ($1,$2,$3,$4,$5)`,
      [milestone.id, milestone.contract_id, milestone.seq, milestone.due_date, milestone.qty_kg]
    );
    await expect(
      livePool!.query(
        `INSERT INTO marketplace.offtake_milestones (id, contract_id, seq, due_date, qty_kg)
         VALUES ('pgtest-off-ms-dup', $1, $2, '2027-06-30', 1000)`,
        [milestone.contract_id, milestone.seq]
      )
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      livePool!.query(
        `UPDATE marketplace.offtake_milestones SET delivered_qty_kg = 2001 WHERE id = $1`,
        [milestone.id]
      )
    ).rejects.toThrow(/delivered_qty_kg/);
  });
});
