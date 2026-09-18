import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgCropPlantingRepository,
  createPgFarmExpenseAllocationRepository,
  createPgFarmExpenseRepository,
  createPgFarmPlotRepository
} from '../../src/database/repositories/farms.pg-repository.js';

/**
 * PostgreSQL parity suite for the W2-FP4 planting lifecycle (dim04 A2/A3/A4;
 * migrations 022_farms.sql + 116_farms_planting_lifecycle.sql +
 * 117_farms_expense_allocations.sql). Skipped unless DATABASE_URL points at
 * a database; migrations are applied idempotently by the suite itself, so
 * only identity.users (001_init.sql) must pre-exist for the plot owner FK.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/farms-lifecycle.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = [
  '022_farms.sql',
  '116_farms_planting_lifecycle.sql',
  '117_farms_expense_allocations.sql'
].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

const plotRow = {
  id: 'pgtest-w2-plot',
  ownerUserId: 'pgtest-w2-farmer',
  name: 'W2 parity plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 11.08,
  centroidLong: 7.72,
  sizeHectares: 2.5,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 1
};

async function clean(): Promise<void> {
  await pool!.query(
    `DELETE FROM farms.expense_allocations WHERE expense_id LIKE 'pgtest-w2-%'`
  );
  for (const [table, column, pattern] of [
    ['farms.farm_expenses', 'plot_id', 'pgtest-w2-%'],
    ['farms.crop_plantings', 'plot_id', 'pgtest-w2-%'],
    ['farms.farm_plots', 'id', 'pgtest-w2-%']
  ] as const) {
    await pool!.query(`DELETE FROM ${table} WHERE ${column} LIKE '${pattern}'`);
  }
}

describePg('pg farms lifecycle repositories (W2-FP4 parity)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
    await pool!.query(
      `INSERT INTO identity.users (id, full_name) VALUES ('pgtest-w2-farmer', 'W2 farmer')
       ON CONFLICT (id) DO NOTHING`
    );
    await createPgFarmPlotRepository(pool!).create(plotRow);
  });

  afterAll(async () => {
    await clean();
    await pool!.end();
  });

  it('A2: replant_of_id round-trips and enforces the self-FK', async () => {
    const plantings = createPgCropPlantingRepository(pool!);
    const base = {
      plotId: plotRow.id,
      crop: 'Maize',
      season: '2025-wet',
      plantedAt: '2025-05-15T00:00:00.000Z',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };
    await plantings.create({ ...base, id: 'pgtest-w2-p1', status: 'failed', failureReason: 'drought' });
    await plantings.create({ ...base, id: 'pgtest-w2-p2', status: 'growing', replantOfId: 'pgtest-w2-p1' });
    const replant = await plantings.getById('pgtest-w2-p2');
    expect(replant.replantOfId).toBe('pgtest-w2-p1');
    expect((await plantings.getById('pgtest-w2-p1')).failureReason).toBe('drought');
    // The self-FK fails closed on a dangling predecessor.
    await expect(
      plantings.create({ ...base, id: 'pgtest-w2-p3', status: 'growing', replantOfId: 'ghost' })
    ).rejects.toThrow();
  });

  it('A3: the status CHECK accepts partially_harvested and rejects junk', async () => {
    const plantings = createPgCropPlantingRepository(pool!);
    await plantings.create({
      id: 'pgtest-w2-p4',
      plotId: plotRow.id,
      crop: 'Tomato',
      season: '2025-wet',
      plantedAt: '2025-05-15T00:00:00.000Z',
      status: 'growing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    });
    const updated = await plantings.update('pgtest-w2-p4', { status: 'partially_harvested' });
    expect(updated.status).toBe('partially_harvested');
    await expect(
      pool!.query(`UPDATE farms.crop_plantings SET status = 'bogus' WHERE id = 'pgtest-w2-p4'`)
    ).rejects.toThrow();
  });

  it('A4: expense allocations persist and join back to expenses', async () => {
    const expenses = createPgFarmExpenseRepository(pool!);
    const allocations = createPgFarmExpenseAllocationRepository(pool!);
    await expenses.create({
      id: 'pgtest-w2-e1',
      plotId: plotRow.id,
      category: 'fertilizer',
      amountKobo: 500_000,
      incurredAt: '2025-06-01T00:00:00.000Z',
      createdAt: new Date().toISOString()
    });
    await allocations.record('pgtest-w2-e1', [
      { plantingId: 'pgtest-w2-p1', sharePercent: 70 },
      { plantingId: 'pgtest-w2-p4', sharePercent: 30 }
    ]);
    const rows = await allocations.listForExpenses(['pgtest-w2-e1']);
    expect(rows).toEqual([
      { expenseId: 'pgtest-w2-e1', plantingId: 'pgtest-w2-p1', sharePercent: 70 },
      { expenseId: 'pgtest-w2-e1', plantingId: 'pgtest-w2-p4', sharePercent: 30 }
    ]);
    expect(await allocations.listForPlanting('pgtest-w2-p4')).toEqual([
      { expenseId: 'pgtest-w2-e1', plantingId: 'pgtest-w2-p4', sharePercent: 30 }
    ]);
    // Range CHECK fails closed.
    await expect(
      allocations.record('pgtest-w2-e1', [{ plantingId: 'pgtest-w2-p4', sharePercent: 0 }])
    ).rejects.toThrow();
  });
});
