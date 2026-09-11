import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgBeneficiaryRepository,
  createPgInputVoucherRepository,
  createPgProgrammeFundingRepository,
  createPgSubsidyProgrammeRepository
} from '../../src/database/repositories/input-vouchers.pg-repository.js';

/**
 * PostgreSQL contract suite for the Stage-23/24 funded-float backing SQL
 * (audit A4-10): the conditional reserve UPDATE, the top-up ON CONFLICT
 * replay (+ payload-mismatch 409, audit A4-9), the marker-keyed settle/
 * release data-modifying CTE (exactly-once, audit A4-8 parity), and the
 * allocation-lock transaction that now covers reserve + voucher insert
 * (audit A4-2). Skipped unless DATABASE_URL points at a MIGRATED database
 * (CI's db-contract job runs `npm run migrate` first); migrations 035/046
 * are re-applied idempotently here, doubling as a re-apply check.
 *
 *   docker compose up -d postgres
 *   npm run migrate -w @agric-platform/api
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/programme-funding.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  : null;

const MIGRATIONS = ['035_input_vouchers.sql', '046_voucher_programme_funding.sql'].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

const PREFIX = 'pgtest-pf';
const FARMER = `${PREFIX}-farmer`;
const now = () => new Date().toISOString();

let programmeSeq = 0;

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM input_vouchers.programme_funding_events WHERE programme_id LIKE '${PREFIX}-%'`);
  await pool!.query(`DELETE FROM input_vouchers.programme_funding WHERE programme_id LIKE '${PREFIX}-%'`);
  await pool!.query(`DELETE FROM input_vouchers.vouchers WHERE programme_id LIKE '${PREFIX}-%'`);
  await pool!.query(`DELETE FROM input_vouchers.beneficiaries WHERE programme_id LIKE '${PREFIX}-%'`);
  await pool!.query(`DELETE FROM input_vouchers.programmes WHERE id LIKE '${PREFIX}-%'`);
}

async function makeProgramme(fundedKobo: number): Promise<string> {
  programmeSeq += 1;
  const programmes = createPgSubsidyProgrammeRepository(pool!);
  const funding = createPgProgrammeFundingRepository(pool!);
  const id = `${PREFIX}-prog-${programmeSeq}`;
  await programmes.create({
    id,
    name: 'pg funding contract programme',
    sponsor: 'pg contract suite',
    status: 'ACTIVE',
    perFarmerCapKobo: 10_000_000,
    budgetKobo: 10_000_000,
    eligibleStates: [],
    eligibleCrops: [],
    liabilityAccountCode: `programme:${id}:liability`,
    createdBy: `${PREFIX}-admin`,
    createdAt: now(),
    updatedAt: now()
  });
  if (fundedKobo > 0) {
    const topUp = await funding.creditTopUp({
      id: `${PREFIX}-ev-init-${programmeSeq}`,
      programmeId: id,
      kind: 'top_up',
      amountKobo: fundedKobo,
      idempotencyKey: `${PREFIX}-init-${programmeSeq}`,
      createdBy: `${PREFIX}-admin`,
      createdAt: now()
    });
    expect(topUp.replayed).toBe(false);
  }
  return id;
}

describePg('pg programme_funding contract (stage 23/24, audit A4-10)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
    await pool!.query(
      `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [FARMER, '+2340000000099', 'pg funding contract farmer']
    );
  });

  afterAll(async () => {
    if (pool) {
      await clean();
      await pool.query(`DELETE FROM identity.users WHERE id = $1`, [FARMER]);
      await pool.end();
    }
  });

  it('re-applies migrations 035/046 idempotently and enforces the backing CHECK', async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8')); // second apply must not throw
    }
    const programmeId = await makeProgramme(100_000);
    // The CHECK programme_funding_backed rejects direct over-reservation.
    await expect(
      pool!.query(
        'UPDATE input_vouchers.programme_funding SET reserved_kobo = reserved_kobo + $1 WHERE programme_id = $2',
        [100_001, programmeId]
      )
    ).rejects.toThrow(/programme_funding_backed/);
  });

  it('creditTopUp credits exactly once per key; a same-key DIFFERENT-amount replay is a 409 (audit A4-9)', async () => {
    const funding = createPgProgrammeFundingRepository(pool!);
    const programmeId = await makeProgramme(0);
    const first = await funding.creditTopUp({
      id: `${PREFIX}-ev-topup-1`,
      programmeId,
      kind: 'top_up',
      amountKobo: 100_000,
      idempotencyKey: `${PREFIX}-topup-key-1`,
      createdBy: `${PREFIX}-admin`,
      createdAt: now()
    });
    expect(first.replayed).toBe(false);
    expect(first.funding.fundedKobo).toBe(100_000);
    // Same key, same payload → replay, no double credit.
    const replay = await funding.creditTopUp({
      id: `${PREFIX}-ev-topup-2`,
      programmeId,
      kind: 'top_up',
      amountKobo: 100_000,
      idempotencyKey: `${PREFIX}-topup-key-1`,
      createdBy: `${PREFIX}-admin`,
      createdAt: now()
    });
    expect(replay.replayed).toBe(true);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.funding.fundedKobo).toBe(100_000);
    // Same key, DIFFERENT amount → 409 (payload-mismatch doctrine).
    await expect(
      funding.creditTopUp({
        id: `${PREFIX}-ev-topup-3`,
        programmeId,
        kind: 'top_up',
        amountKobo: 250_000,
        idempotencyKey: `${PREFIX}-topup-key-1`,
        createdBy: `${PREFIX}-admin`,
        createdAt: now()
      })
    ).rejects.toBeInstanceOf(ConflictException);
    const final = await funding.getFunding(programmeId);
    expect(final?.fundedKobo).toBe(100_000);
  });

  it('concurrent reserves against one float: exactly-one-wins per kobo (conditional UPDATE serialises)', async () => {
    const funding = createPgProgrammeFundingRepository(pool!);
    const programmeId = await makeProgramme(100_000);
    // Three concurrent 60k reservations against a 100k float — exactly one
    // can win; the losers move 0 rows (false), never overdraw.
    const results = await Promise.all([
      funding.reserve(programmeId, 60_000),
      funding.reserve(programmeId, 60_000),
      funding.reserve(programmeId, 60_000)
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const state = await funding.getFunding(programmeId);
    expect(state?.reservedKobo).toBe(60_000);
    // The remaining 40k is still reservable; the next 60k is not.
    expect(await funding.reserve(programmeId, 40_000)).toBe(true);
    expect(await funding.reserve(programmeId, 60_000)).toBe(false);
    const after = await funding.getFunding(programmeId);
    expect(after?.reservedKobo).toBe(100_000);
  });

  it('settle/release markers apply exactly once under concurrent retry (data-modifying CTE)', async () => {
    const funding = createPgProgrammeFundingRepository(pool!);
    const programmeId = await makeProgramme(200_000);
    expect(await funding.reserve(programmeId, 100_000)).toBe(true);
    // Concurrent duplicate settle attempts with the SAME voucher marker:
    // the marker insert decides the winner; the funding moves exactly once.
    await Promise.all([
      funding.settleReserved(programmeId, 100_000, `${PREFIX}-settle:v1`, `${PREFIX}-admin`),
      funding.settleReserved(programmeId, 100_000, `${PREFIX}-settle:v1`, `${PREFIX}-admin`)
    ]);
    const settled = await funding.getFunding(programmeId);
    expect(settled?.reservedKobo).toBe(0);
    expect(settled?.settledKobo).toBe(100_000);
    // A third replay is a no-op.
    await funding.settleReserved(programmeId, 100_000, `${PREFIX}-settle:v1`, `${PREFIX}-admin`);
    expect((await funding.getFunding(programmeId))?.settledKobo).toBe(100_000);

    expect(await funding.reserve(programmeId, 50_000)).toBe(true);
    await Promise.all([
      funding.releaseReserved(programmeId, 50_000, `${PREFIX}-release:v2`, `${PREFIX}-admin`),
      funding.releaseReserved(programmeId, 50_000, `${PREFIX}-release:v2`, `${PREFIX}-admin`)
    ]);
    const released = await funding.getFunding(programmeId);
    expect(released?.reservedKobo).toBe(0);
    expect(released?.settledKobo).toBe(100_000); // settle untouched by release
  });

  it('a legacy (unbacked) marker no-ops BUT records the marker, so a later retry cannot move another reservation (audit A4-8 pg semantics)', async () => {
    const funding = createPgProgrammeFundingRepository(pool!);
    const programmeId = await makeProgramme(0);
    const marker = `${PREFIX}-release:legacy-1`;
    // No funding row exists: the UPDATE matches nothing, the marker inserts.
    await funding.releaseReserved(programmeId, 60_000, marker, `${PREFIX}-admin`);
    // Unrelated activity: top-up + a real reservation behind the marker key.
    await funding.creditTopUp({
      id: `${PREFIX}-ev-legacy-topup`,
      programmeId,
      kind: 'top_up',
      amountKobo: 100_000,
      idempotencyKey: `${PREFIX}-legacy-topup`,
      createdBy: `${PREFIX}-admin`,
      createdAt: now()
    });
    expect(await funding.reserve(programmeId, 60_000)).toBe(true);
    // Crash-resume retry of the legacy release: the marker already exists,
    // so the CTE's UPDATE must NOT fire against the new reservation.
    await funding.releaseReserved(programmeId, 60_000, marker, `${PREFIX}-admin`);
    const state = await funding.getFunding(programmeId);
    expect(state?.reservedKobo).toBe(60_000);
    expect(state?.settledKobo).toBe(0);
  });

  it('allocation lock transaction covers reserve + voucher insert: both commit, or BOTH roll back (audit A4-2)', async () => {
    const programmes = createPgSubsidyProgrammeRepository(pool!);
    const vouchers = createPgInputVoucherRepository(pool!);
    const beneficiaries = createPgBeneficiaryRepository(pool!);
    const funding = createPgProgrammeFundingRepository(pool!);
    const programmeId = await makeProgramme(150_000);
    await beneficiaries.create({
      id: `${PREFIX}-ben-1`,
      programmeId,
      farmerId: FARMER,
      ninHash: `${PREFIX}-ninhash-1`,
      ninMask: '********001',
      verificationBasis: 'stub',
      verifiedAt: now(),
      createdAt: now()
    });

    // Happy path: reserve + insert commit together inside the lock tx.
    const committed = await programmes.withAllocationLock(programmeId, async (tx) => {
      expect(await funding.reserve(programmeId, 100_000, tx)).toBe(true);
      return vouchers.create(
        {
          id: `${PREFIX}-voucher-1`,
          programmeId,
          beneficiaryId: `${PREFIX}-ben-1`,
          farmerId: FARMER,
          amountKobo: 100_000,
          status: 'ISSUED',
          idempotencyKey: `${PREFIX}-alloc-1`,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: now()
        },
        tx
      );
    });
    expect(committed.id).toBe(`${PREFIX}-voucher-1`);
    expect((await funding.getFunding(programmeId))?.reservedKobo).toBe(100_000);

    // Failure path: a throwing callback AFTER the reserve rolls the
    // reservation back with the (never-inserted) voucher — no leak.
    await expect(
      programmes.withAllocationLock(programmeId, async (tx) => {
        expect(await funding.reserve(programmeId, 50_000, tx)).toBe(true);
        throw new Error('simulated post-reserve failure');
      })
    ).rejects.toThrow('simulated post-reserve failure');
    const after = await funding.getFunding(programmeId);
    expect(after?.reservedKobo).toBe(100_000); // only the committed voucher
    expect(await vouchers.findByIdempotencyKey(`${PREFIX}-alloc-2`)).toBeUndefined();

    // The allocation lock serialises concurrent callbacks for one programme:
    // the waiter blocks until the holder's transaction ends.
    const order: string[] = [];
    const holder = programmes.withAllocationLock(programmeId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push('first');
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // holder is inside the lock
    await programmes.withAllocationLock(programmeId, async () => {
      order.push('second');
    });
    await holder;
    expect(order).toEqual(['first', 'second']);
  });
});
