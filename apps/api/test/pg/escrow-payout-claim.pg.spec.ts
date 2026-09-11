import { afterEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import type { EscrowPayout } from '@agric-platform/shared';
import {
  claimPayoutAttempt,
  finalizePayoutAttempt,
  hashPayoutPayload,
  PAYOUT_CLAIM_LEASE_MS
} from '../../src/database/repositories/payout.repository.js';
import {
  createPgEscrowRepository,
  PgEscrowPayoutRepository
} from '../../src/database/repositories/commerce.pg-repository.js';
import { createPgOrderRepository } from '../../src/database/repositories/marketplace.pg-repository.js';

/**
 * Escrow payout rail claim contract (Stage 24, audit A4-3 / A4-10;
 * migrations 048 + 049 + 052).
 *
 * Two layers, mirroring the 047 audit-chain pg patterns:
 *  - `pg escrow payout claim (query spy)`: always-on tests over a fake pool
 *    proving the claim CAS and finalize guard compile to single guarded
 *    UPDATE statements whose preconditions pin status (and the claimant's
 *    lease start), never overwriting 'succeeded'.
 *  - `pg escrow payout claim (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style, exercised by CI's db-contract
 *    job against a database with migrations through 052 applied. Two
 *    concurrent claims of the same attempt must produce EXACTLY ONE
 *    claimant (the would-be double driver invocation), and a stale failure
 *    finalize must never regress a succeeded attempt.
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

function attemptTemplate(overrides: Partial<EscrowPayout> = {}): Omit<EscrowPayout, 'status' | 'claimedAt'> {
  const base = {
    escrowId: 'contract-payout-escrow-1',
    orderId: 'contract-payout-order-1',
    kind: 'release' as const,
    amountKobo: 37_000_000
  };
  const now = new Date().toISOString();
  return {
    id: 'contract-payout-1',
    ...base,
    idempotencyKey: 'escrow-payout:release:contract-payout-escrow-1',
    payloadHash: hashPayoutPayload(base),
    provider: 'stub',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

const storedRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'contract-payout-1',
  escrow_id: 'contract-payout-escrow-1',
  order_id: 'contract-payout-order-1',
  kind: 'release',
  amount_kobo: 37_000_000,
  idempotency_key: 'escrow-payout:release:contract-payout-escrow-1',
  payload_hash: attemptTemplate().payloadHash,
  provider: 'stub',
  provider_reference: null,
  status: 'failed',
  claimed_at: null,
  failure_reason: 'rail unreachable',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...overrides
});

describe('pg escrow payout claim (query spy)', () => {
  it('claims a failed attempt with a single guarded UPDATE pinning the prior status', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.startsWith('SELECT')) {
        return { rows: [storedRow()] };
      }
      return { rows: [storedRow({ status: 'in_progress' })], rowCount: 1 };
    });
    const repo = new PgEscrowPayoutRepository(pool);

    const claim = await claimPayoutAttempt(repo, attemptTemplate());

    expect(claim.claimed).toBe(true);
    const update = calls.find((call) => call.text.startsWith('UPDATE marketplace.escrow_payouts'));
    expect(update).toBeDefined();
    // One atomic conditional UPDATE: claim is set only while the row is
    // still in the observed pre-claim status.
    expect(update!.text).toContain("SET status = $2, claimed_at = $3, updated_at = $4");
    expect(update!.text).toContain('WHERE id = $1 AND status = $5');
    expect(update!.params).toContain('in_progress');
    expect(update!.params).toContain('failed');
  });

  it('the CAS loser (0 rows) re-reads and is rejected 409 in-progress', async () => {
    const { pool } = fakePool((text, params) => {
      if (text.startsWith('SELECT') && String(text).includes('WHERE id = $1')) {
        // The re-read after the lost race: the twin now holds a fresh claim.
        return { rows: [storedRow({ status: 'in_progress', claimed_at: new Date().toISOString() })] };
      }
      if (text.startsWith('SELECT')) {
        return { rows: [storedRow()] };
      }
      return { rows: [], rowCount: 0 }; // guarded UPDATE matched nothing
      void params;
    });
    const repo = new PgEscrowPayoutRepository(pool);

    await expect(claimPayoutAttempt(repo, attemptTemplate())).rejects.toThrowError(
      ConflictException
    );
  });

  it('finalize issues a guarded UPDATE that pins in_progress + the claimant lease', async () => {
    const claimedAt = '2026-08-22T10:00:00.000Z';
    const { pool, calls } = fakePool((text) => {
      void text;
      return { rows: [storedRow({ status: 'succeeded', claimed_at: claimedAt })], rowCount: 1 };
    });
    const repo = new PgEscrowPayoutRepository(pool);
    const claim = {
      ...attemptTemplate(),
      status: 'in_progress' as const,
      claimedAt
    };

    await finalizePayoutAttempt(repo, claim, { status: 'succeeded', providerReference: 'psp-1' });

    const update = calls.find((call) => call.text.startsWith('UPDATE marketplace.escrow_payouts'));
    expect(update).toBeDefined();
    // WHERE id AND status = 'in_progress' AND claimed_at = <our lease> — a
    // 'succeeded' row never matches, so it can never regress to 'failed'.
    expect(update!.text).toContain('WHERE id = $1 AND status = $5 AND claimed_at = $6');
    expect(update!.params[0]).toBe('contract-payout-1');
    expect(update!.params[1]).toBe('psp-1'); // mapper column order: provider_reference before status
    expect(update!.params[2]).toBe('succeeded');
    expect(update!.params[4]).toBe('in_progress');
    expect(update!.params[5]).toBe(claimedAt);
  });
});

/**
 * Live contract tests. Skipped unless DATABASE_URL points at a database with
 * migrations through 052 applied (see test/pg/pg-repositories.spec.ts header
 * for the docker compose invocation; CI's db-contract job runs them).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// NOTE: deliberately NOT 'contract-*' — pg-repositories.spec.ts cleans up
// `LIKE 'contract-%'` across shared tables while suites run in parallel, so
// contract-prefixed rows here would be deleted mid-test (and its escrow
// DELETE would FK-fail against our payout rows).
const CONTRACT_PREFIX = 'payoutclaim-';

/**
 * Seeds the FK chain a payout row needs: listing → order → escrow
 * (escrow_payouts references escrow_records, which references orders and
 * listings — same seeding pattern as pg-repositories.spec.ts).
 */
async function seedEscrow(id: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO marketplace.listings (id, seller_id, kind, title, quantity, unit, price_ngn)
     VALUES ($1, $2, 'produce', 'Payout claim contract listing', 100, 'tonnes', 370000)
     ON CONFLICT (id) DO NOTHING`,
    [`${CONTRACT_PREFIX}listing`, `${CONTRACT_PREFIX}seller`]
  );
  await createPgOrderRepository(pool).placeOrder({
    id: `${id}-order`,
    listingId: `${CONTRACT_PREFIX}listing`,
    buyerId: `${CONTRACT_PREFIX}buyer`,
    sellerId: `${CONTRACT_PREFIX}seller`,
    quantity: 1,
    totalNaira: 370_000,
    status: 'confirmed',
    escrowRequired: true,
    createdAt: new Date().toISOString()
  });
  await createPgEscrowRepository(pool).create({
    id,
    orderId: `${id}-order`,
    amountKobo: 37_000_000,
    status: 'held',
    heldAt: new Date().toISOString(),
    heldUntil: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()
  });
}

async function cleanContractRows(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM marketplace.escrow_payouts WHERE escrow_id LIKE $1`, [
    `${CONTRACT_PREFIX}%`
  ]);
  await pool.query(`DELETE FROM marketplace.escrow_records WHERE id LIKE $1`, [
    `${CONTRACT_PREFIX}%`
  ]);
  await pool.query(`DELETE FROM marketplace.orders WHERE id LIKE $1`, [`${CONTRACT_PREFIX}%`]);
  await pool.query(`DELETE FROM marketplace.listings WHERE id LIKE $1`, [`${CONTRACT_PREFIX}%`]);
}

describePg('pg escrow payout claim CAS (migrations 048-052)', () => {
  afterEach(cleanContractRows);
  it('two concurrent claims of the same attempt produce exactly one claimant', async () => {
    if (!pool) return;
    await cleanContractRows();
    await seedEscrow(`${CONTRACT_PREFIX}escrow-race`);
    const template = attemptTemplate({
      id: `${CONTRACT_PREFIX}race-a`,
      escrowId: `${CONTRACT_PREFIX}escrow-race`,
      orderId: `${CONTRACT_PREFIX}escrow-race-order`,
      idempotencyKey: `escrow-payout:release:${CONTRACT_PREFIX}escrow-race`
    });
    template.payloadHash = hashPayoutPayload(template);
    const repoA = new PgEscrowPayoutRepository(pool);
    const repoB = new PgEscrowPayoutRepository(pool);

    const outcomes = await Promise.allSettled([
      claimPayoutAttempt(repoA, template),
      claimPayoutAttempt(repoB, { ...template, id: `${CONTRACT_PREFIX}race-b` })
    ]);
    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter((o) => o.status === 'rejected');
    expect(winners).toHaveLength(1); // exactly one driver invocation happens
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const rows = await pool.query(
      `SELECT status, claimed_at FROM marketplace.escrow_payouts WHERE idempotency_key = $1`,
      [template.idempotencyKey]
    );
    expect(rows.rows).toHaveLength(1); // UNIQUE(idempotency_key) held under race
    expect(rows.rows[0].status).toBe('in_progress');
    expect(rows.rows[0].claimed_at).not.toBeNull();
    await cleanContractRows();
  });

  it('succeeded never regresses: a stale failure finalize is adopted, not written', async () => {
    if (!pool) return;
    await cleanContractRows();
    await seedEscrow(`${CONTRACT_PREFIX}escrow-regress`);
    const template = attemptTemplate({
      id: `${CONTRACT_PREFIX}regress`,
      escrowId: `${CONTRACT_PREFIX}escrow-regress`,
      orderId: `${CONTRACT_PREFIX}escrow-regress-order`,
      idempotencyKey: `escrow-payout:release:${CONTRACT_PREFIX}escrow-regress`
    });
    template.payloadHash = hashPayoutPayload(template);
    const repo = new PgEscrowPayoutRepository(pool);

    const claim = await claimPayoutAttempt(repo, template);
    expect(claim.claimed).toBe(true);
    await finalizePayoutAttempt(repo, claim.attempt, {
      status: 'succeeded',
      providerReference: 'psp-contract-1'
    });
    // A stale writer (crashed-and-resumed twin) finalizes 'failed' with the
    // old lease: the guarded write must refuse the regression.
    const adopted = await finalizePayoutAttempt(repo, claim.attempt, {
      status: 'failed',
      failureReason: 'late ambiguous timeout'
    });
    expect(adopted.status).toBe('succeeded');
    const row = await pool.query(
      `SELECT status, provider_reference FROM marketplace.escrow_payouts WHERE id = $1`,
      [template.id]
    );
    expect(row.rows[0].status).toBe('succeeded');
    expect(row.rows[0].provider_reference).toBe('psp-contract-1');
    // And a fresh claim attempt on the succeeded row replays without claiming.
    const replay = await claimPayoutAttempt(repo, { ...template, id: `${CONTRACT_PREFIX}regress-2` });
    expect(replay.claimed).toBe(false);
    await cleanContractRows();
  });

  it('an expired in_progress lease is re-claimable (crash recovery)', async () => {
    if (!pool) return;
    await cleanContractRows();
    await seedEscrow(`${CONTRACT_PREFIX}escrow-lease`);
    const template = attemptTemplate({
      id: `${CONTRACT_PREFIX}lease`,
      escrowId: `${CONTRACT_PREFIX}escrow-lease`,
      orderId: `${CONTRACT_PREFIX}escrow-lease-order`,
      idempotencyKey: `escrow-payout:release:${CONTRACT_PREFIX}escrow-lease`
    });
    template.payloadHash = hashPayoutPayload(template);
    const repo = new PgEscrowPayoutRepository(pool);

    const crashedAt = new Date(Date.now() - PAYOUT_CLAIM_LEASE_MS - 60_000);
    const crashed = await claimPayoutAttempt(repo, template, crashedAt);
    expect(crashed.claimed).toBe(true);
    // A retry while the lease is fresh would 409; after expiry it re-claims.
    const reclaimed = await claimPayoutAttempt(repo, { ...template, id: `${CONTRACT_PREFIX}lease-2` });
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.attempt.id).toBe(template.id);
    await cleanContractRows();
  });

  it('049: the deposit reference UNIQUE index rejects cross-order reuse at the database layer', async () => {
    if (!pool) return;
    await cleanContractRows();
    await seedEscrow(`${CONTRACT_PREFIX}escrow-ref-a`);
    await seedEscrow(`${CONTRACT_PREFIX}escrow-ref-b`);
    const reference = 'paystack:contract-ref-paid-once';
    await pool.query(
      `UPDATE marketplace.escrow_records SET deposit_payment_reference = $1 WHERE id = $2`,
      [reference, `${CONTRACT_PREFIX}escrow-ref-a`]
    );
    await expect(
      pool.query(
        `UPDATE marketplace.escrow_records SET deposit_payment_reference = $1 WHERE id = $2`,
        [reference, `${CONTRACT_PREFIX}escrow-ref-b`]
      )
    ).rejects.toMatchObject({ code: '23505' });
    // NULL references (legacy/declarative rows) are untouched by the index.
    await cleanContractRows();
  });
});
