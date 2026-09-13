/**
 * Lender Lens pg contract tests (Stage 27, innovation #20; migration 079).
 *
 * Two layers, standard plan-§9.3 pattern:
 *   - always-on unit tests over a fake pool proving the guarded INSERT
 *     shapes (ON CONFLICT DO NOTHING + re-read) and the immutability
 *     conflict mapping;
 *   - live contract tests (skipped unless DATABASE_URL is set) proving the
 *     migration applies idempotently, the CHECK constraints reject malformed
 *     periods/hashes, and payload immutability per (lender, version, period)
 *     holds against real PostgreSQL.
 *
 * Plus the PII-denylist contract: a stored scorecard payload can never
 * contain farmer identifier keys (aggregate-only doctrine).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  assertPayloadHasNoPii,
  assembleScorecard,
  DEFAULT_SCORECARD_DEFINITION,
  scorecardPayloadHash
} from '../../src/modules/analytics/lender-scorecard.js';
import { PgLenderScorecardRepository } from '../../src/database/repositories/lender-scorecard.pg-repository.js';
import type { LenderScorecardRow } from '../../src/database/repositories/lender-scorecard.repository.js';

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
        command: 'INSERT',
        oid: 0,
        fields: []
      };
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

const PERIOD = '2026-08';

function samplePayload(lenderPartnerId: string) {
  return assembleScorecard(DEFAULT_SCORECARD_DEFINITION, lenderPartnerId, '1.0.0', PERIOD, [
    {
      productId: 'prod-cash',
      borrowerState: 'Kaduna',
      status: 'repaying',
      createdAt: '2026-05-10T08:00:00.000Z',
      repayments: [{ dueAt: '2026-07-15T00:00:00.000Z', amountKobo: 100_000, status: 'pending' }]
    }
  ]);
}

function sampleRow(lenderPartnerId: string): LenderScorecardRow {
  const payload = samplePayload(lenderPartnerId);
  return {
    id: `pgtest-lsc-${lenderPartnerId}`,
    lenderPartnerId,
    version: '1.0.0',
    period: PERIOD,
    payload,
    payloadHash: scorecardPayloadHash(payload),
    generatedAt: '2026-09-01T00:00:00.000Z'
  };
}

function storedRow(row: LenderScorecardRow): Record<string, unknown> {
  return {
    id: row.id,
    lender_partner_id: row.lenderPartnerId,
    version: row.version,
    period: row.period,
    payload: row.payload,
    payload_hash: row.payloadHash,
    generated_at: row.generatedAt
  };
}

describe('pg lender scorecard repository (query spy)', () => {
  it('inserts with ON CONFLICT DO NOTHING (race-safe immutability guard)', async () => {
    const row = sampleRow('lender-a');
    const { pool, calls } = fakePool(() => ({ rows: [storedRow(row)] }));
    const repo = new PgLenderScorecardRepository(pool);
    const result = await repo.insertScorecard(row);
    expect(result.created).toBe(true);
    expect(calls[0]!.text).toContain('ON CONFLICT (lender_partner_id, version, period) DO NOTHING');
    expect(calls[0]!.params).toEqual([
      row.id,
      row.lenderPartnerId,
      row.version,
      row.period,
      JSON.stringify(row.payload),
      row.payloadHash,
      row.generatedAt
    ]);
  });

  it('treats an identical replay as idempotent (created=false)', async () => {
    const row = sampleRow('lender-a');
    const { pool } = fakePool((text) => {
      if (text.startsWith('INSERT INTO analytics.lender_scorecards')) {
        return { rows: [], rowCount: 0 }; // conflict: nothing inserted
      }
      return { rows: [storedRow(row)] }; // re-read returns the stored row
    });
    const repo = new PgLenderScorecardRepository(pool);
    const result = await repo.insertScorecard({ ...row, id: 'pgtest-lsc-replay' });
    expect(result.created).toBe(false);
    expect(result.row.payloadHash).toBe(row.payloadHash);
  });

  it('rejects a divergent payload for the same (lender, version, period) with 409', async () => {
    const row = sampleRow('lender-a');
    const { pool } = fakePool((text) => {
      if (text.startsWith('INSERT INTO analytics.lender_scorecards')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [storedRow(row)] };
    });
    const repo = new PgLenderScorecardRepository(pool);
    await expect(
      repo.insertScorecard({ ...row, id: 'pgtest-lsc-divergent', payloadHash: 'f'.repeat(64) })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects re-publishing a version with a different definition', async () => {
    const stored = {
      version: '1.0.0',
      definition: { ...DEFAULT_SCORECARD_DEFINITION, geoMixFloorBps: 0 },
      published_at: '2026-08-01T00:00:00.000Z',
      published_by: 'admin-1'
    };
    const { pool } = fakePool((text) => {
      if (text.startsWith('INSERT INTO analytics.lender_scorecard_versions')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [stored] };
    });
    const repo = new PgLenderScorecardRepository(pool);
    await expect(
      repo.publishVersion({
        version: '1.0.0',
        definition: DEFAULT_SCORECARD_DEFINITION,
        publishedAt: '2026-09-01T00:00:00.000Z',
        publishedBy: 'admin-2'
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('PII-denylist contract: assembled payloads never carry farmer identifiers', () => {
    const payload = samplePayload('lender-a');
    expect(() => assertPayloadHasNoPii(payload)).not.toThrow();
    const keys = canonicalKeys(payload);
    for (const denied of ['userid', 'farmer', 'borrower', 'nin', 'bvn', 'phone', 'email']) {
      expect(keys.some((key) => key.includes(denied))).toBe(false);
    }
  });
});

/** Every key at any depth, lower-cased. */
function canonicalKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => canonicalKeys(entry));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key.toLowerCase(),
    ...canonicalKeys(child)
  ]);
}

/* ----------------------------------------------------------- live pg -- */

const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = ['019_analytics.sql', '079_lender_scorecards.sql'].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'infra', 'postgres', file)
);

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM analytics.portfolio_benchmarks WHERE version = 'pgtest-1.0.0'`);
  await pool!.query(`DELETE FROM analytics.lender_scorecards WHERE id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM analytics.lender_scorecard_versions WHERE version = 'pgtest-1.0.0'`);
}

describePg('pg lender scorecard contract (live)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
  });

  afterAll(async () => {
    if (pool) {
      await clean();
      await pool.end();
    }
  });

  it('applies migration 079 idempotently', async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8')); // second apply must not throw
    }
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'analytics'
         AND (table_name LIKE 'lender_scorecard%' OR table_name = 'portfolio_benchmarks')
       ORDER BY table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(['lender_scorecards', 'lender_scorecard_versions', 'portfolio_benchmarks'])
    );
  });

  it('enforces payload immutability per (lender, version, period)', async () => {
    const repo = new PgLenderScorecardRepository(pool!);
    await repo.publishVersion({
      version: 'pgtest-1.0.0',
      definition: DEFAULT_SCORECARD_DEFINITION,
      publishedAt: '2026-09-01T00:00:00.000Z',
      publishedBy: 'pgtest-admin'
    });
    const row = { ...sampleRow('lender-a'), id: 'pgtest-lsc-live', version: 'pgtest-1.0.0' };
    const first = await repo.insertScorecard(row);
    expect(first.created).toBe(true);
    const replay = await repo.insertScorecard({ ...row, id: 'pgtest-lsc-live-replay' });
    expect(replay.created).toBe(false);
    await expect(
      repo.insertScorecard({ ...row, id: 'pgtest-lsc-live-divergent', payloadHash: 'e'.repeat(64) })
    ).rejects.toBeInstanceOf(ConflictException);
    const stored = await repo.scorecard('lender-a', 'pgtest-1.0.0', PERIOD);
    expect(stored?.payloadHash).toBe(row.payloadHash);
  });

  it('rejects malformed period and payload_hash via CHECK constraints', async () => {
    const repo = new PgLenderScorecardRepository(pool!);
    await repo.publishVersion({
      version: 'pgtest-1.0.0',
      definition: DEFAULT_SCORECARD_DEFINITION,
      publishedAt: '2026-09-01T00:00:00.000Z'
    });
    const row = { ...sampleRow('lender-a'), id: 'pgtest-lsc-badperiod', version: 'pgtest-1.0.0' };
    await expect(repo.insertScorecard({ ...row, period: '2026-13' })).rejects.toThrow();
    await expect(
      repo.insertScorecard({ ...row, id: 'pgtest-lsc-badhash', payloadHash: 'nothex' })
    ).rejects.toThrow();
  });
});
