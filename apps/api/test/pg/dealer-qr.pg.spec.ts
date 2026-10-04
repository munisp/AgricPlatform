import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgDealerQRRepository } from '../../src/database/repositories/dealer-qr.pg-repository.js';
import type { DealerQRPurchase, DealerQRToken } from '@agric-platform/shared';

/**
 * PostgreSQL suite for the Dealer QR repositories (wave P2c; migration
 * 073_dealer_qr.sql). Skipped unless DATABASE_URL points at a database; the
 * migration is applied idempotently by the suite itself.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/dealer-qr.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '073_dealer_qr.sql'
);

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM input_vouchers.dealer_qr_purchases WHERE dealer_id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM input_vouchers.dealer_qr_tokens WHERE dealer_id LIKE 'pgtest-%'`);
}

function token(id: string): DealerQRToken {
  return {
    id,
    dealerId: 'pgtest-dealer-1',
    batch: 'batch-A',
    qrPayload: `payload-${id}`,
    issuedAt: '2026-06-01T10:00:00.000Z',
    createdAt: '2026-06-01T10:00:00.000Z'
  };
}

function purchase(id: string, tokenId: string, dedupeKey?: string): DealerQRPurchase {
  return {
    id,
    dealerId: 'pgtest-dealer-1',
    tokenId,
    farmerId: 'pgtest-farmer-1',
    amountKobo: 150_000,
    inputItems: [{ product: 'NPK 15-15-15', quantity: 2, unit: '50kg bag' }],
    dedupeKey,
    recordedBy: 'pgtest-dealer-1',
    occurredAt: '2026-06-01T10:05:00.000Z',
    createdAt: '2026-06-01T10:05:00.000Z'
  };
}

describePg('pg dealer QR repositories (parity with in-memory)', () => {
  beforeAll(async () => {
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
    await clean();
  });

  afterAll(async () => {
    await clean();
    await pool!.end();
  });

  it('creates and reads back a token by id and by QR payload', async () => {
    const repo = createPgDealerQRRepository(pool!);
    await repo.createToken(token('pgtest-qr-1'));
    const byId = await repo.getTokenById('pgtest-qr-1');
    expect(byId).toMatchObject({
      id: 'pgtest-qr-1',
      dealerId: 'pgtest-dealer-1',
      batch: 'batch-A',
      qrPayload: 'payload-pgtest-qr-1',
      issuedAt: '2026-06-01T10:00:00.000Z'
    });
    const byPayload = await repo.getTokenByPayload('payload-pgtest-qr-1');
    expect(byPayload?.id).toBe('pgtest-qr-1');
    expect(await repo.getTokenByPayload('payload-missing')).toBeUndefined();
  });

  it('findTokens filters by dealer and batch', async () => {
    const repo = createPgDealerQRRepository(pool!);
    await repo.createToken({ ...token('pgtest-qr-2'), batch: 'batch-B' });
    await repo.createToken(token('pgtest-qr-3'));
    const all = await repo.findTokens({ dealerId: 'pgtest-dealer-1' });
    expect(all.map((row) => row.id).sort()).toEqual(['pgtest-qr-2', 'pgtest-qr-3']);
    const batchA = await repo.findTokens({ dealerId: 'pgtest-dealer-1', batch: 'batch-A' });
    expect(batchA.map((row) => row.id)).toEqual(['pgtest-qr-3']);
  });

  it('markRedeemed flips once; the second flip returns undefined (replay-safe)', async () => {
    const repo = createPgDealerQRRepository(pool!);
    await repo.createToken(token('pgtest-qr-4'));
    const patch = {
      redeemedAt: '2026-06-01T10:06:00.000Z',
      redeemedFarmerId: 'pgtest-farmer-1',
      redeemedPurchaseId: 'pgtest-po-1'
    };
    const flipped = await repo.markRedeemed('pgtest-qr-4', patch);
    expect(flipped).toMatchObject(patch);
    const again = await repo.markRedeemed('pgtest-qr-4', patch);
    expect(again).toBeUndefined();
    const stored = await repo.getTokenById('pgtest-qr-4');
    expect(stored?.redeemedAt).toBe('2026-06-01T10:06:00.000Z');
  });

  it('createPurchase round-trips items and amount; dedupe replays return the original row', async () => {
    const repo = createPgDealerQRRepository(pool!);
    await repo.createToken(token('pgtest-qr-5'));
    const first = await repo.createPurchase(purchase('pgtest-po-1', 'pgtest-qr-5', 'dk-1'));
    expect(first.amountKobo).toBe(150_000);
    expect(first.inputItems).toEqual([{ product: 'NPK 15-15-15', quantity: 2, unit: '50kg bag' }]);

    // Replay with the same dedupe key: the UNIQUE index fires and the
    // repository answers with the original row instead of throwing.
    const replay = await repo.createPurchase(purchase('pgtest-po-2', 'pgtest-qr-5', 'dk-1'));
    expect(replay.id).toBe('pgtest-po-1');
    expect(await repo.countPurchasesByFarmer('pgtest-farmer-1')).toBe(1);

    // A different key inserts normally.
    const second = await repo.createPurchase(purchase('pgtest-po-3', 'pgtest-qr-5', 'dk-2'));
    expect(second.id).toBe('pgtest-po-3');
    expect(await repo.countPurchasesByFarmer('pgtest-farmer-1')).toBe(2);
  });

  it('findPurchases filters by dealer, farmer and token', async () => {
    const repo = createPgDealerQRRepository(pool!);
    await repo.createToken(token('pgtest-qr-6'));
    await repo.createToken(token('pgtest-qr-7'));
    await repo.createPurchase(purchase('pgtest-po-4', 'pgtest-qr-6'));
    await repo.createPurchase({ ...purchase('pgtest-po-5', 'pgtest-qr-7'), farmerId: 'pgtest-farmer-2' });

    expect((await repo.findPurchases({ dealerId: 'pgtest-dealer-1' })).length).toBeGreaterThanOrEqual(2);
    expect((await repo.findPurchases({ farmerId: 'pgtest-farmer-2' })).map((row) => row.id)).toEqual([
      'pgtest-po-5'
    ]);
    expect((await repo.findPurchases({ tokenId: 'pgtest-qr-6' })).map((row) => row.id)).toEqual([
      'pgtest-po-4'
    ]);
  });
});
