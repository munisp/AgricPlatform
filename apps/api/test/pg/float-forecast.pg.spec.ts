import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import type {
  FloatForecastRecord,
  RebalanceAlertRecord,
  RebalanceRunRecord
} from '../../src/database/repositories/float-forecast.repository.js';
import {
  PgFloatForecastRepository,
  PgRebalanceAlertRepository,
  PgRebalanceRunRepository
} from '../../src/database/repositories/float-forecast.pg-repository.js';

/**
 * Float Forecaster pg contract (Stage 27, Innovation 15; migration 073).
 *
 * Two layers, mirroring the 047/052 pg patterns:
 *  - `pg float forecaster (query spy)`: always-on tests over a fake pool
 *    proving the rerun-idempotent upsert shape, the guarded claim UPDATE
 *    (open AND unclaimed), the CAS WHERE compilation, and 23505 → 409.
 *  - `pg float forecaster (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style, exercised by CI's db-contract job
 *    against a database with migration 073 applied: the partial unique index
 *    allows exactly ONE open alert per agent per type, and the forecast
 *    upsert key makes same-day re-runs idempotent.
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

function forecastTemplate(overrides: Partial<FloatForecastRecord> = {}): FloatForecastRecord {
  return {
    id: 'forecast-1',
    agentId: 'agent-1',
    forecastDate: '2026-01-18',
    dayOffset: 1,
    targetDate: '2026-01-19',
    horizonDays: 14,
    predictedNetFlowKobo: -50_000,
    predictedEodFloatKobo: 250_000,
    basis: 'seasonal_trend',
    modelVersion: 'seasonal-naive-trend-v1',
    computedAt: '2026-01-18T23:00:00.000Z',
    ...overrides
  };
}

function alertTemplate(overrides: Partial<RebalanceAlertRecord> = {}): RebalanceAlertRecord {
  return {
    id: 'alert-1',
    agentId: 'agent-1',
    alertType: 'depletion',
    predictedBreachAt: '2026-01-22',
    predictedEodFloatKobo: 100_000,
    thresholdKobo: 100_000,
    status: 'open',
    modelVersion: 'seasonal-naive-trend-v1',
    createdAt: '2026-01-18T23:00:00.000Z',
    updatedAt: '2026-01-18T23:00:00.000Z',
    ...overrides
  };
}

function alertRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'alert-1',
    agent_id: 'agent-1',
    alert_type: 'depletion',
    predicted_breach_at: '2026-01-22',
    predicted_eod_float_kobo: 100_000,
    threshold_kobo: 100_000,
    status: 'acknowledged',
    run_id: null,
    model_version: 'seasonal-naive-trend-v1',
    acknowledged_by: 'ops-1',
    acknowledged_at: '2026-01-19T08:00:00.000Z',
    resolved_by: null,
    resolved_at: null,
    resolution: null,
    created_at: '2026-01-18T23:00:00.000Z',
    updated_at: '2026-01-19T08:00:00.000Z',
    ...overrides
  };
}

describe('pg float forecaster (query spy)', () => {
  it('forecast upsert targets the rerun-identity key and refreshes predictions', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    await new PgFloatForecastRepository(pool).upsert(forecastTemplate());
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO agent_banking.float_forecasts');
    expect(calls[0].text).toContain(
      'ON CONFLICT (agent_id, forecast_date, day_offset, model_version) DO UPDATE'
    );
    expect(calls[0].text).toContain('computed_at = EXCLUDED.computed_at');
    expect(calls[0].params[0]).toBe('forecast-1');
    expect(calls[0].params[6]).toBe(-50_000);
  });

  it('alert create surfaces the partial-unique 23505 as a 409', async () => {
    const { pool } = fakePool(() => Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(
      new PgRebalanceAlertRepository(pool).create(alertTemplate())
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ack CAS compiles expected status into the WHERE clause and 409s on 0 rows', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const repo = new PgRebalanceAlertRepository(pool);
    await expect(
      repo.updateExpected(
        'alert-1',
        { status: 'acknowledged', acknowledgedBy: 'ops-1' },
        { status: 'open' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls[0].text).toContain('UPDATE agent_banking.rebalance_alerts SET');
    expect(calls[0].text).toContain('RETURNING *');
    // $1 is the id; expected status='open' is the last parameter.
    expect(calls[0].params[0]).toBe('alert-1');
    expect(calls[0].params[calls[0].params.length - 1]).toBe('open');
  });

  it('claimForRun is a single guarded UPDATE (open AND unclaimed)', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [alertRow({ status: 'open', run_id: 'run-1' })] }));
    const claimed = await new PgRebalanceAlertRepository(pool).claimForRun(
      'alert-1',
      'run-1',
      '2026-01-19T09:00:00.000Z'
    );
    expect(claimed.runId).toBe('run-1');
    expect(calls[0].text).toContain("status = 'open' AND run_id IS NULL");
    const { pool: losingPool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await expect(
      new PgRebalanceAlertRepository(losingPool).claimForRun('alert-1', 'run-2', '2026-01-19T09:01:00.000Z')
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('run create/round-trip maps snake_case columns', async () => {
    const run: RebalanceRunRecord = {
      id: 'run-1',
      status: 'planned',
      alertCount: 2,
      notes: 'Kano north loop',
      createdBy: 'ops-1',
      createdAt: '2026-01-19T09:00:00.000Z',
      updatedAt: '2026-01-19T09:00:00.000Z'
    };
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    await new PgRebalanceRunRepository(pool).create(run);
    expect(calls[0].text).toContain('INSERT INTO agent_banking.rebalance_runs');
    expect(calls[0].params).toEqual([
      'run-1',
      'planned',
      2,
      'Kano north loop',
      'ops-1',
      '2026-01-19T09:00:00.000Z',
      '2026-01-19T09:00:00.000Z'
    ]);
  });
});

/**
 * Live contract layer — requires DATABASE_URL with migrations through 073
 * applied (see docs for the docker compose invocation; CI's db-contract job
 * runs them).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const PREFIX = 'ffcontract-';

async function seedAgent(id: string): Promise<void> {
  if (!pool) return;
  await pool.query('INSERT INTO identity.users (id, full_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
    `${PREFIX}user-${id}`,
    'Forecast contract user'
  ]);
  await pool.query(
    'INSERT INTO agent_banking.agents (id, user_id, organisation, status, float_account_code, ' +
      'commission_account_code, daily_limit_kobo, low_float_threshold_kobo) ' +
      "VALUES ($1, $2, 'Forecast contract coop', 'ACTIVE', $3, $4, 10000000, 100000) ON CONFLICT (id) DO NOTHING",
    [`${PREFIX}${id}`, `${PREFIX}user-${id}`, `agent:${PREFIX}${id}:float`, `agent:${PREFIX}${id}:commission`]
  );
}

describePg('pg float forecaster (live)', () => {
  it('partial unique index: exactly one OPEN alert per agent per type', async () => {
    if (!pool) return;
    await seedAgent('a1');
    const alerts = new PgRebalanceAlertRepository(pool);
    const first = await alerts.create(alertTemplate({ id: `${PREFIX}alert-1`, agentId: `${PREFIX}a1` }));
    expect(first.status).toBe('open');
    // A second OPEN depletion alert for the same agent violates the index.
    await expect(
      alerts.create(alertTemplate({ id: `${PREFIX}alert-2`, agentId: `${PREFIX}a1` }))
    ).rejects.toBeInstanceOf(ConflictException);
    // A DIFFERENT type is fine (dedupe is per agent+type).
    await alerts.create(
      alertTemplate({ id: `${PREFIX}alert-3`, agentId: `${PREFIX}a1`, alertType: 'excess' })
    );
    // After resolve, a fresh open depletion alert may exist again.
    await alerts.updateExpected(
      `${PREFIX}alert-1`,
      { status: 'resolved', resolvedBy: 'ops', resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { status: 'open' }
    );
    await alerts.create(alertTemplate({ id: `${PREFIX}alert-4`, agentId: `${PREFIX}a1` }));
  });

  it('forecast upsert is rerun-idempotent on (agent, date, offset, model)', async () => {
    if (!pool) return;
    await seedAgent('a2');
    const forecasts = new PgFloatForecastRepository(pool);
    const base = forecastTemplate({ id: `${PREFIX}f1`, agentId: `${PREFIX}a2` });
    await forecasts.upsert(base);
    // Same identity key, new prediction: refreshes, never duplicates.
    await forecasts.upsert(forecastTemplate({ id: `${PREFIX}f2`, agentId: `${PREFIX}a2`, predictedNetFlowKobo: -49_000 }));
    const rows = await forecasts.find({ agentId: `${PREFIX}a2`, forecastDate: '2026-01-18' });
    expect(rows).toHaveLength(1);
    expect(rows[0].predictedNetFlowKobo).toBe(-49_000);
    // A different model_version is a NEW row (versions never rewrite each other).
    await forecasts.upsert({ ...base, id: `${PREFIX}f3`, modelVersion: 'seasonal-naive-trend-v2' });
    expect(await forecasts.find({ agentId: `${PREFIX}a2` })).toHaveLength(2);
  });

  it('claimForRun admits exactly one claimant', async () => {
    if (!pool) return;
    await seedAgent('a3');
    const alerts = new PgRebalanceAlertRepository(pool);
    const runs = new PgRebalanceRunRepository(pool);
    const now = new Date().toISOString();
    await runs.create({
      id: `${PREFIX}run-1`,
      status: 'planned',
      alertCount: 1,
      createdBy: 'ops',
      createdAt: now,
      updatedAt: now
    });
    await runs.create({
      id: `${PREFIX}run-2`,
      status: 'planned',
      alertCount: 1,
      createdBy: 'ops',
      createdAt: now,
      updatedAt: now
    });
    await alerts.create(alertTemplate({ id: `${PREFIX}alert-c1`, agentId: `${PREFIX}a3` }));
    const claimed = await alerts.claimForRun(`${PREFIX}alert-c1`, `${PREFIX}run-1`, now);
    expect(claimed.runId).toBe(`${PREFIX}run-1`);
    await expect(
      alerts.claimForRun(`${PREFIX}alert-c1`, `${PREFIX}run-2`, now)
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
