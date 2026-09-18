import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPgEscrowRepository } from '../../src/database/repositories/commerce.pg-repository.js';
import { createPgOrderRepository } from '../../src/database/repositories/marketplace.pg-repository.js';
import {
  PgWarehouseReceiptRepository,
  warehouseReceiptCriteriaSql
} from '../../src/database/repositories/warehouse.pg-repository.js';

/**
 * Wave-2 W2-C3 contract specs (migrations 105-109):
 *
 *  V-06 escrow split settlement (105_escrow_split_settlement.sql): a
 *    disputed escrow resolves into released_kobo + refunded_kobo parts
 *    (summing exactly to the held amount) under the terminal 'settled'
 *    status. The guarded write must compile to ONE UPDATE pinning the
 *    pre-settlement status — never an unguarded overwrite.
 *  V-36 partial fulfilment (106_order_partial_fulfilment.sql): the order's
 *    delivered_quantity persists through the same guarded UPDATE pattern.
 *  V-37 receipt split (108_receipt_split.sql): child receipt rows carry
 *    parent_receipt_id + split_seq; the parent-children query compiles.
 *
 * Layers, mirroring the 048 payout-claim pg patterns:
 *  - query spy (always on): SQL shape/params over a fake pool;
 *  - live (describe.skipIf(!DATABASE_URL)): exercised by CI's db-contract
 *    job against a database with migrations through 109 applied.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
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
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

const escrowRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'escrow-1',
  order_id: 'order-1',
  amount_kobo: 37_000_000,
  currency: 'NGN',
  status: 'settled',
  created_at: new Date(),
  updated_at: new Date(),
  resolved_at: new Date(),
  deposit_payment_reference: null,
  deposit_verified_at: null,
  delivery_point_h3: null,
  geofence_radius_cells: null,
  delivery_confirm_until: null,
  released_kobo: 22_200_000,
  refunded_kobo: 14_800_000,
  ...overrides
});

describe('pg V-06 split settlement write (query spy)', () => {
  it('persists the 60/40 award parts in ONE guarded UPDATE pinning the disputed status', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [escrowRow()] }));
    const repo = createPgEscrowRepository(pool);
    // The service's terminal write: settled with both award parts, guarded
    // on the disputed pre-state (CAS — a concurrent resolution loses).
    const updated = await repo.updateExpected(
      'escrow-1',
      { status: 'settled', releasedKobo: 22_200_000, refundedKobo: 14_800_000 },
      { status: 'disputed' }
    );
    expect(calls).toHaveLength(1);
    const { text, params } = calls[0];
    expect(text).toContain('UPDATE marketplace.escrow_records');
    expect(text).toContain('released_kobo');
    expect(text).toContain('refunded_kobo');
    expect(text).toContain('WHERE id = $1 AND');
    expect(params).toContain(22_200_000);
    expect(params).toContain(14_800_000);
    expect(params).toContain('disputed'); // the guard precondition
    // Round-trip: the parts sum EXACTLY to the held amount (60/40 of 37M kobo).
    expect(updated.status).toBe('settled');
    expect(updated.releasedKobo! + updated.refundedKobo!).toBe(37_000_000);
  });

  it('a lost CAS race (no row returned) throws, never a silent overwrite', async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const repo = createPgEscrowRepository(pool);
    // PgRepositoryBase answers a lost guard race with NotFound; the service
    // layer re-reads and surfaces the conflict to the caller.
    await expect(
      repo.updateExpected(
        'escrow-1',
        { status: 'settled', releasedKobo: 22_200_000, refundedKobo: 14_800_000 },
        { status: 'disputed' }
      )
    ).rejects.toThrowError(/not found/i);
  });
});

describe('pg V-36 partial fulfilment write (query spy)', () => {
  it('persists delivered_quantity in ONE guarded UPDATE pinning in_fulfilment', async () => {
    const orderRow: Record<string, unknown> = {
      id: 'order-1',
      listing_id: 'listing-1',
      buyer_id: 'buyer-1',
      seller_id: 'seller-1',
      quantity: 10,
      total_naira: 100_000,
      status: 'delivered',
      escrow_required: true,
      idempotency_key: null,
      payload_hash: null,
      delivered_quantity: 7,
      created_at: new Date()
    };
    const { pool, calls } = fakePool(() => ({ rows: [orderRow] }));
    const repo = createPgOrderRepository(pool);
    const updated = await repo.updateExpected(
      'order-1',
      { status: 'delivered', deliveredQuantity: 7 },
      { status: 'in_fulfilment' }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('UPDATE marketplace.orders');
    expect(calls[0].text).toContain('delivered_quantity');
    expect(calls[0].params).toContain(7);
    expect(calls[0].params).toContain('in_fulfilment');
    // 70% of 10 units delivered → 70% of the escrow settles to the seller.
    expect(updated.deliveredQuantity).toBe(7);
  });
});

describe('pg V-37 receipt split rows (query spy)', () => {
  it('child rows carry parent_receipt_id + split_seq and the children query compiles', async () => {
    const childRow: Record<string, unknown> = {
      id: 'whr-child-1',
      receipt_number: 'WHR-2026-CHILD001',
      deposit_id: 'deposit-1',
      warehouse_id: 'warehouse-1',
      owner_id: 'user-farmer',
      crop: 'maize',
      grade: 'A',
      bag_count: 24,
      weight_kg: 1200,
      status: 'active',
      nonce: 'nonce-c1',
      signature: 'sig-c1',
      issued_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      parent_receipt_id: 'whr-parent-1',
      split_seq: 1,
      lost_weight_kg: null,
      lost_bag_count: null,
      regraded_to: null
    };
    const { pool, calls } = fakePool(() => ({ rows: [childRow] }));
    const repo = new PgWarehouseReceiptRepository(pool);
    const children = await repo.find({ parentReceiptId: 'whr-parent-1' });
    expect(calls[0].text).toContain('parent_receipt_id');
    expect(calls[0].params).toContain('whr-parent-1');
    expect(children).toHaveLength(1);
    expect(children[0].parentReceiptId).toBe('whr-parent-1');
    expect(children[0].splitSeq).toBe(1);
    // criteria SQL exposes the parent filter used by split replay.
    const clause = warehouseReceiptCriteriaSql({ parentReceiptId: 'whr-parent-1' });
    expect(clause.where).toContain('parent_receipt_id');
  });
});

/* ---------------------------------------------------------------------------
 * Live contract layer (CI db-contract job; migrations through 109 applied).
 * ------------------------------------------------------------------------- */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

describePg('pg W2-C3 live (migrations 105-109)', () => {
  it('round-trips a split-settled escrow row with the exact award parts', async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const repo = createPgEscrowRepository(pool);
      await pool.query(
        `INSERT INTO marketplace.orders (id, listing_id, buyer_id, seller_id, quantity, total_naira, status, escrow_required, created_at)
         VALUES ('pg-w2c3-order-1', 'listing-x', 'buyer-x', 'seller-x', 2, 370000, 'disputed', true, now())
         ON CONFLICT (id) DO NOTHING`
      );
      await repo.create({
        id: 'pg-w2c3-escrow-1',
        orderId: 'pg-w2c3-order-1',
        amountKobo: 37_000_000,
        currency: 'NGN',
        status: 'disputed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      const settled = await repo.updateExpected(
        'pg-w2c3-escrow-1',
        { status: 'settled', releasedKobo: 22_200_000, refundedKobo: 14_800_000, resolvedAt: new Date().toISOString() },
        { status: 'disputed' }
      );
      expect(settled.status).toBe('settled');
      expect(settled.releasedKobo! + settled.refundedKobo!).toBe(settled.amountKobo);
    } finally {
      await pool.end();
    }
  });
});
