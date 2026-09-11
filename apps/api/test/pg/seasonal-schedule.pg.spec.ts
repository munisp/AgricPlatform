import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgSeasonalScheduleRepository } from '../../src/database/repositories/seasonal-schedule.pg-repository.js';
import type { CreditSeasonalSchedule } from '@agric-platform/shared';

/**
 * PostgreSQL contract suite for SeasonSync (innovation wave 27, batch 1 #1):
 * migration 055 applies idempotently, the harvest-window CHECK rejects
 * inverted windows, the installments JSONB round-trips integer kobo, the
 * accept CAS enforces previewed → accepted, and the partial unique index
 * guarantees exactly one accepted schedule per loan.
 *
 * Skipped unless DATABASE_URL points at a MIGRATED database (CI's
 * db-contract job runs `npm run migrate` first); migration 055 is re-applied
 * here, doubling as a re-apply check.
 *
 *   docker compose up -d postgres
 *   npm run migrate -w @agric-platform/api
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/seasonal-schedule.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  : null;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '055_credit_seasonal_schedules.sql'
);

const PREFIX = 'pgtest-seasonsync';
const FARMER = `${PREFIX}-farmer`;
const OFFICER = `${PREFIX}-officer`;
const PRODUCT = `${PREFIX}-product`;
const PLOT = `${PREFIX}-plot`;
const LOAN = `${PREFIX}-loan`;
const now = () => new Date().toISOString();

let scheduleSeq = 0;

function makeSchedule(overrides: Partial<CreditSeasonalSchedule> = {}): CreditSeasonalSchedule {
  scheduleSeq += 1;
  return {
    id: `${PREFIX}-sched-${scheduleSeq}`,
    loanId: LOAN,
    plotId: PLOT,
    crop: 'maize',
    plantingDate: '2026-04-01',
    harvestWindowStart: '2026-07-15',
    harvestWindowEnd: '2026-08-14',
    installments: [
      { sequence: 1, dueAt: '2026-07-15T00:00:00.000Z', amountKobo: 353_059 },
      { sequence: 2, dueAt: '2026-08-14T00:00:00.000Z', amountKobo: 706_119 }
    ],
    version: scheduleSeq,
    status: 'previewed',
    createdBy: OFFICER,
    createdAt: now(),
    ...overrides
  };
}

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM credit.seasonal_schedules WHERE loan_id = $1`, [LOAN]);
  await pool!.query(`DELETE FROM credit.loan_repayments WHERE loan_id = $1`, [LOAN]);
  await pool!.query(`DELETE FROM credit.loan_applications WHERE id = $1`, [LOAN]);
  await pool!.query(`DELETE FROM credit.loan_products WHERE id = $1`, [PRODUCT]);
  await pool!.query(`DELETE FROM farms.crop_plantings WHERE plot_id = $1`, [PLOT]);
  await pool!.query(`DELETE FROM farms.farm_plots WHERE id = $1`, [PLOT]);
}

describePg('pg seasonal_schedules contract (SeasonSync, migration 055)', () => {
  beforeAll(async () => {
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
    await clean();
    await pool!.query(
      `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [FARMER, '+2340000000101', 'pg seasonsync contract farmer']
    );
    await pool!.query(
      `INSERT INTO credit.loan_products
         (id, name, min_principal_kobo, max_principal_kobo, interest_bps_annual, term_days)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [PRODUCT, 'pg seasonsync product', 100_000, 5_000_000, 1200, 180]
    );
    await pool!.query(
      `INSERT INTO farms.farm_plots
         (id, owner_user_id, name, state, lga, centroid_lat, centroid_long, size_hectares)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [PLOT, FARMER, 'pg seasonsync plot', 'Kaduna', 'Zaria', 11.1, 7.7, 1.5]
    );
    await pool!.query(
      `INSERT INTO credit.loan_applications
         (id, applicant_user_id, product_id, principal_kobo, status)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [LOAN, FARMER, PRODUCT, 1_000_000, 'approved']
    );
  });

  afterAll(async () => {
    if (pool) {
      await clean();
      await pool.query(`DELETE FROM identity.users WHERE id = $1`, [FARMER]);
      await pool.end();
    }
  });

  it('re-applies migration 055 idempotently', async () => {
    await pool!.query(readFileSync(MIGRATION, 'utf8')); // second apply must not throw
    const check = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM credit.seasonal_schedules WHERE loan_id = $1`,
      [LOAN]
    );
    expect(check.rows[0].n).toBe(0);
  });

  it('enforces CHECK (harvest_window_end > harvest_window_start)', async () => {
    const repo = createPgSeasonalScheduleRepository(pool!);
    const inverted = makeSchedule({
      harvestWindowStart: '2026-08-14',
      harvestWindowEnd: '2026-07-15'
    });
    await expect(repo.create(inverted)).rejects.toThrow();
  });

  it('round-trips the installments JSON and calendar unchanged', async () => {
    const repo = createPgSeasonalScheduleRepository(pool!);
    const record = makeSchedule();
    await repo.create(record);
    const stored = await repo.getById(record.id);
    expect(stored.loanId).toBe(LOAN);
    expect(stored.plotId).toBe(PLOT);
    expect(stored.crop).toBe('maize');
    expect(stored.plantingDate).toBe('2026-04-01');
    expect(stored.harvestWindowStart).toBe('2026-07-15');
    expect(stored.harvestWindowEnd).toBe('2026-08-14');
    expect(stored.installments).toEqual(record.installments);
    expect(
      stored.installments.reduce((sum, installment) => sum + installment.amountKobo, 0)
    ).toBe(1_059_178);
    expect(stored.status).toBe('previewed');
    expect(stored.createdBy).toBe(OFFICER);
  });

  it('accept CAS: previewed → accepted succeeds once, replay conflicts', async () => {
    const repo = createPgSeasonalScheduleRepository(pool!);
    const record = makeSchedule();
    await repo.create(record);
    const accepted = await repo.updateStatusExpected(record.id, 'accepted', 'previewed', {
      acceptedAt: now()
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedAt).toBeDefined();
    await expect(
      repo.updateStatusExpected(record.id, 'accepted', 'previewed')
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('partial unique index: exactly one accepted schedule per loan', async () => {
    const repo = createPgSeasonalScheduleRepository(pool!);
    const first = makeSchedule();
    const second = makeSchedule();
    await repo.create(first);
    await repo.create(second);
    await repo.updateStatusExpected(first.id, 'accepted', 'previewed');
    await expect(
      repo.updateStatusExpected(second.id, 'accepted', 'previewed')
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('SET NULL on plot delete never rewrites the pinned terms', async () => {
    const repo = createPgSeasonalScheduleRepository(pool!);
    const record = makeSchedule();
    await repo.create(record);
    await pool!.query(`DELETE FROM farms.farm_plots WHERE id = $1`, [PLOT]);
    const stored = await repo.getById(record.id);
    expect(stored.plotId).toBeUndefined();
    expect(stored.installments).toEqual(record.installments);
    expect(stored.harvestWindowStart).toBe('2026-07-15');
    // Restore the plot fixture for subsequent tests/cleanup symmetry.
    await pool!.query(
      `INSERT INTO farms.farm_plots
         (id, owner_user_id, name, state, lga, centroid_lat, centroid_long, size_hectares)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [PLOT, FARMER, 'pg seasonsync plot', 'Kaduna', 'Zaria', 11.1, 7.7, 1.5]
    );
  });
});
