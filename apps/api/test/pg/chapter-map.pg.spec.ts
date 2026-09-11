import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  CHAPTER_MAP_UPSERT_BATCH,
  PgChapterMapSnapshotRepository,
  PgChapterMemberDirectory
} from '../../src/database/repositories/chapter-map.pg-repository.js';
import type { ChapterMapSnapshot } from '../../src/database/repositories/chapter-map.repository.js';

/**
 * Chapter Map pg contract (Innovation 10, Stage 27; migration 068).
 *
 * Three layers, mirroring the 047/052 audit pg patterns and the privacy
 * module's PII hygiene doctrine:
 *  - query spy (always on): the snapshot upsert compiles to a batched
 *    multi-row INSERT ... ON CONFLICT on the composite PK (idempotent
 *    recompute), and the member directory reads the existing roster table.
 *  - migration source scan (always on): the column set of
 *    geo_intel.chapter_map_snapshots is parsed out of 068 and asserted
 *    against a PII denylist — the snapshot cache must NEVER grow a
 *    farmer-identifying column (k-anonymity is enforced at read time; this
 *    is the structural guarantee there is nothing to de-anonymise).
 *  - live (describe.skipIf(!DATABASE_URL)): the same denylist scan against
 *    information_schema, plus a real PK idempotent-recompute round trip.
 */

/** Columns that must never appear on the aggregate snapshot table. */
const PII_DENYLIST = [
  'nin',
  'nin_hash',
  'bvn',
  'msisdn',
  'phone',
  'email',
  'name',
  'user_id',
  'farmer_id',
  'member_id',
  'supplier_id',
  'beneficiary_id',
  'lat',
  'long',
  'lng',
  'latitude',
  'longitude',
  'device_id',
  'address',
  'payload_hash'
] as const;

const EXPECTED_COLUMNS = ['chapter_id', 'h3_res7', 'metric', 'value_numeric', 'computed_at'];

/** Parses the CREATE TABLE column list out of the migration, keyword-free. */
function migrationColumnNames(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    join(here, '..', '..', '..', '..', 'infra', 'postgres', '068_chapter_map_snapshots.sql'),
    'utf8'
  );
  const lines = sql.split(String.fromCharCode(10)); // newline split, backslash-free source
  const start = lines.findIndex((line) =>
    line.includes('CREATE TABLE IF NOT EXISTS geo_intel.chapter_map_snapshots')
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const columns: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === ');') {
      // End of the CREATE TABLE statement (CHECK bodies close with ')),').
      break;
    }
    // Backslash-free tokenisation: the migration is space-indented.
    const token = line.split(' ').filter((part) => part.length > 0)[0] ?? '';
    // Column names are snake_case identifiers; this skips the PRIMARY KEY /
    // CHECK lines and the enum literal lines inside the CHECK body.
    if (!/^[a-z_][a-z0-9_]*$/.test(token)) {
      continue;
    }
    columns.push(token);
  }
  return columns;
}

function assertNoPiiColumns(columns: readonly string[]): void {
  expect(columns.length).toBeGreaterThan(0);
  for (const column of columns) {
    expect(
      PII_DENYLIST.includes(column as (typeof PII_DENYLIST)[number]),
      `column '${column}' is on the PII denylist — the snapshot cache carries k-anonymised aggregates only`
    ).toBe(false);
  }
}

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number };

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

function snapshotRow(index: number, overrides: Partial<ChapterMapSnapshot> = {}): ChapterMapSnapshot {
  return {
    chapterId: 'ch-spy',
    h3Res7: `87581b96${index}ffffff`,
    metric: 'member_count',
    valueNumeric: index,
    computedAt: '2026-09-15T10:00:00.000Z',
    ...overrides
  };
}

describe('pg chapter map snapshots (query spy)', () => {
  it('upsertMany compiles to a multi-row INSERT with ON CONFLICT on the composite PK', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 2 }));
    const repo = new PgChapterMapSnapshotRepository(pool);

    const written = await repo.upsertMany([snapshotRow(1), snapshotRow(2)]);

    expect(written).toBe(2);
    expect(calls).toHaveLength(1);
    const insert = calls[0];
    expect(insert.text).toContain('INSERT INTO geo_intel.chapter_map_snapshots');
    expect(insert.text).toContain('ON CONFLICT (chapter_id, h3_res7, metric)');
    expect(insert.text).toContain('DO UPDATE SET value_numeric = EXCLUDED.value_numeric');
    expect(insert.text).toContain('computed_at = EXCLUDED.computed_at');
    expect(insert.params).toHaveLength(10); // 5 columns x 2 rows, fully parameterised
    expect(insert.params[0]).toBe('ch-spy');
  });

  it('batches oversized upserts (PK upsert stays idempotent across batches)', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const repo = new PgChapterMapSnapshotRepository(pool);
    const rows = Array.from({ length: CHAPTER_MAP_UPSERT_BATCH + 1 }, (_, index) =>
      snapshotRow(index)
    );

    const written = await repo.upsertMany(rows);

    expect(written).toBe(rows.length);
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toHaveLength(5); // remainder batch of one row
  });

  it('findByChapter narrows by metric with a parameterised WHERE', async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [
        {
          chapter_id: 'ch-spy',
          h3_res7: '87581b966ffffff',
          metric: 'member_count',
          value_numeric: '5',
          computed_at: '2026-09-15T10:00:00.000Z'
        }
      ]
    }));
    const repo = new PgChapterMapSnapshotRepository(pool);

    const rows = await repo.findByChapter('ch-spy', 'member_count');

    expect(calls[0].text).toContain('WHERE chapter_id = $1 AND metric = $2');
    expect(calls[0].params).toEqual(['ch-spy', 'member_count']);
    expect(rows).toEqual([
      {
        chapterId: 'ch-spy',
        h3Res7: '87581b966ffffff',
        metric: 'member_count',
        valueNumeric: 5, // numeric column mapped to a number
        computedAt: '2026-09-15T10:00:00.000Z'
      }
    ]);
  });

  it('the member directory reads the existing chapters.chapter_members roster', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ user_id: 'u1' }, { user_id: 'u2' }] }));
    const directory = new PgChapterMemberDirectory(pool);

    const memberIds = await directory.listMemberIds('ch-spy');

    expect(calls[0].text).toContain('FROM chapters.chapter_members WHERE chapter_id = $1');
    expect(calls[0].params).toEqual(['ch-spy']);
    expect(memberIds).toEqual(['u1', 'u2']);
  });
});

describe('chapter map snapshot column set (migration source scan)', () => {
  it('068 declares exactly the aggregate columns and none on the PII denylist', () => {
    const columns = migrationColumnNames();
    expect(columns).toEqual(EXPECTED_COLUMNS);
    assertNoPiiColumns(columns);
  });
});

/**
 * Live contract tests. Skipped unless DATABASE_URL points at a database with
 * migrations through 068 applied (CI's db-contract job runs them; see
 * test/pg/pg-repositories.spec.ts for the docker compose invocation).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// NOT 'contract-%': pg-repositories.spec.ts cleans that prefix across shared
// tables while suites run in parallel (see escrow-payout-claim.pg.spec.ts).
const CONTRACT_PREFIX = 'chaptermap-';

async function cleanContractRows(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM geo_intel.chapter_map_snapshots WHERE chapter_id LIKE $1`, [
    `${CONTRACT_PREFIX}%`
  ]);
  await pool.query(`DELETE FROM chapters.chapters WHERE id LIKE $1`, [`${CONTRACT_PREFIX}%`]);
}

describePg('pg chapter map snapshots (live, migration 068)', () => {
  afterEach(cleanContractRows);

  it('the live column set matches the denylist-free aggregate contract', async () => {
    if (!pool) return;
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'geo_intel' AND table_name = 'chapter_map_snapshots'
       ORDER BY ordinal_position`
    );
    const columns = result.rows.map((row) => row.column_name as string);
    expect(columns).toEqual(EXPECTED_COLUMNS);
    assertNoPiiColumns(columns);
  });

  it('recompute upserts are idempotent on the composite PK (rewrite, never duplicate)', async () => {
    if (!pool) return;
    await cleanContractRows();
    await pool.query(
      `INSERT INTO chapters.chapters (id, level, name, state)
       VALUES ($1, 'ward', 'Chapter Map contract chapter', 'Kaduna')
       ON CONFLICT (id) DO NOTHING`,
      [`${CONTRACT_PREFIX}chapter`]
    );
    const repo = new PgChapterMapSnapshotRepository(pool);
    const base = {
      chapterId: `${CONTRACT_PREFIX}chapter`,
      h3Res7: '87581b966ffffff'
    };

    await repo.upsertMany([
      { ...base, metric: 'member_count', valueNumeric: 7, computedAt: '2026-09-15T10:00:00.000Z' }
    ]);
    // A recompute of the same cell+metric rewrites the row in place.
    await repo.upsertMany([
      { ...base, metric: 'member_count', valueNumeric: 9, computedAt: '2026-09-15T11:00:00.000Z' }
    ]);

    const rows = await repo.findByChapter(`${CONTRACT_PREFIX}chapter`, 'member_count');
    expect(rows).toHaveLength(1);
    expect(rows[0].valueNumeric).toBe(9);
    expect(rows[0].computedAt).toBe('2026-09-15T11:00:00.000Z');

    const count = await pool.query(
      `SELECT count(*)::int AS n FROM geo_intel.chapter_map_snapshots WHERE chapter_id = $1`,
      [`${CONTRACT_PREFIX}chapter`]
    );
    expect(count.rows[0].n).toBe(1);
    await cleanContractRows();
  });

  it('rejects metric values outside the enum (CHECK constraint)', async () => {
    if (!pool) return;
    await cleanContractRows();
    await pool.query(
      `INSERT INTO chapters.chapters (id, level, name, state)
       VALUES ($1, 'ward', 'Chapter Map contract chapter', 'Kaduna')
       ON CONFLICT (id) DO NOTHING`,
      [`${CONTRACT_PREFIX}chapter`]
    );
    await expect(
      pool.query(
        `INSERT INTO geo_intel.chapter_map_snapshots
           (chapter_id, h3_res7, metric, value_numeric)
         VALUES ($1, $2, $3, $4)`,
        [`${CONTRACT_PREFIX}chapter`, '87581b966ffffff', 'farmer_name', 1]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await cleanContractRows();
  });
});
