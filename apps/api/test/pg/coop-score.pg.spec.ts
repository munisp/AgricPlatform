import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgCoopScoreRepository,
  PgCoopScoreRepository
} from '../../src/database/repositories/coop-score.pg-repository.js';
import type { CoopScoreRecord } from '../../src/database/repositories/coop-score.repository.js';

/**
 * Cooperative-score pg contract (stage-27 Innovation 14, migration 072).
 *
 * Two layers:
 *  - `pg coop score append (query spy)`: always-on unit tests over a fake
 *    pool proving the atomic append INSERT shape (version subquery, ON
 *    CONFLICT idempotency, RETURNING) and the no-op recompute path.
 *  - `pg coop_scores contract`: live tests in the standard
 *    describe.skipIf(!DATABASE_URL) style — append-only versioning, the
 *    0-1000/band CHECKs, and recompute idempotency against a database with
 *    migration 072 applied (applied idempotently by the suite itself).
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
      return { rows: outcome.rows, rowCount: outcome.rowCount ?? outcome.rows.length };
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

function record(overrides: Partial<CoopScoreRecord> = {}): Omit<CoopScoreRecord, 'version'> {
  return {
    id: 'cscore-test-1',
    cooperativeId: 'chapter-coop-1',
    score: 845,
    band: 'A',
    factors: [
      {
        key: 'repaymentTrackRecord',
        weight: 300,
        points: 255,
        basis: 'measured',
        summary: { loansConsidered: 5 }
      }
    ],
    inputsHash: 'abc12345',
    computedAt: '2026-09-12T00:00:00.000Z',
    ...overrides
  };
}

const ROW = {
  id: 'cscore-test-1',
  cooperative_id: 'chapter-coop-1',
  version: 3,
  score: 845,
  band: 'A',
  factor_scores: record().factors,
  inputs_hash: 'abc12345',
  computed_at: '2026-09-12T00:00:00.000Z'
};

describe('pg coop score append (query spy)', () => {
  it('appends via one atomic INSERT … SELECT max(version)+1 with idempotency guard', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [ROW] }));
    const repository = new PgCoopScoreRepository(pool);

    const appended = await repository.append(record());

    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;
    expect(text).toContain('INSERT INTO credit.coop_scores');
    expect(text).toContain('COALESCE(MAX(version), 0) + 1');
    expect(text).toContain('ON CONFLICT (cooperative_id, inputs_hash) DO NOTHING');
    expect(text).toContain('RETURNING *');
    expect(params).toEqual([
      'cscore-test-1',
      'chapter-coop-1',
      845,
      'A',
      JSON.stringify(record().factors),
      'abc12345',
      '2026-09-12T00:00:00.000Z'
    ]);
    expect(appended?.version).toBe(3);
    expect(appended?.band).toBe('A');
  });

  it('recompute with an identical inputs hash is a no-op (undefined, no row)', async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const repository = new PgCoopScoreRepository(pool);
    await expect(repository.append(record())).resolves.toBeUndefined();
  });

  it('a version-race unique violation fails loud (ConflictException), never silent', async () => {
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { pool } = fakePool(() => conflict);
    const repository = new PgCoopScoreRepository(pool);
    await expect(repository.append(record())).rejects.toThrowError(/unique/i);
  });

  it('reads latest by version DESC and history newest-first', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [ROW] }));
    const repository = new PgCoopScoreRepository(pool);
    await repository.latestFor('chapter-coop-1');
    expect(calls[0]!.text).toContain('ORDER BY version DESC');
    expect(calls[0]!.text).toContain('LIMIT 1');
    await repository.historyFor('chapter-coop-1');
    expect(calls[1]!.text).toContain('ORDER BY version DESC');
  });
});

/* --------------------------------------------------------- live contract -- */

const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = ['001_init.sql', '025_credit.sql', '072_cooperative_score.sql'].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

describePg('pg coop_scores contract (migration 072)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await pool!.query(`DELETE FROM credit.coop_scores WHERE id LIKE 'pgtest-cscore-%'`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('append assigns monotonically increasing versions (append-only history)', async () => {
    const repository = createPgCoopScoreRepository(pool!);
    const first = await repository.append(record({ id: 'pgtest-cscore-1', inputsHash: 'h-1' }));
    const second = await repository.append(
      record({ id: 'pgtest-cscore-2', inputsHash: 'h-2', score: 500, band: 'C' })
    );
    expect(first?.version).toBeGreaterThanOrEqual(1);
    expect(second?.version).toBe(first!.version + 1);
    const history = await repository.historyFor('chapter-coop-1');
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('recompute with identical inputs_hash is idempotent (no new row)', async () => {
    const repository = createPgCoopScoreRepository(pool!);
    const noop = await repository.append(record({ id: 'pgtest-cscore-3', inputsHash: 'h-1' }));
    expect(noop).toBeUndefined();
  });

  it('score CHECK rejects out-of-range values; band CHECK rejects unknown bands', async () => {
    const repository = createPgCoopScoreRepository(pool!);
    await expect(
      repository.append(record({ id: 'pgtest-cscore-4', inputsHash: 'h-4', score: 1001 }))
    ).rejects.toThrow();
    await expect(
      repository.append(
        record({ id: 'pgtest-cscore-5', inputsHash: 'h-5', band: 'E' as never })
      )
    ).rejects.toThrow();
  });
});
