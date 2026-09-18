/**
 * Migration runner (persistence wave plan §3.1). Applies infra/postgres/*.sql
 * in lexical order, recording each file in schema_migrations(filename PK,
 * applied_at). Idempotent: already-applied files are skipped.
 *
 * Baseline detection: databases initialised by docker-entrypoint-initdb.d
 * already ran the migrations without a migrations table. When
 * schema_migrations is empty, two probes decide what to record:
 *   - an artifact of the highest-numbered probed migration (see
 *     LATEST_ARTIFACT_PROBES): every file up to and including it is recorded
 *     as applied (Compose mounts ALL of infra/postgres into
 *     /docker-entrypoint-initdb.d, so a fresh container has run every file);
 *   - otherwise, when 001's final COMMIT block object
 *     (events.processed_events) exists, only 001_init.sql is recorded —
 *     probing identity.users instead would mis-record a database whose 001
 *     run died mid-file (identity.users commits in 001's FIRST block).
 *
 * Non-transactional files (V-76): a migration whose FIRST line is exactly
 * `-- no-transaction` is applied statement-by-statement WITHOUT an
 * enclosing transaction. This exists for DDL that cannot run inside a
 * transaction block (CREATE INDEX CONCURRENTLY) or should not hold one
 * long lock (NOT VALID + VALIDATE CONSTRAINT split). Marker files are
 * restricted to flat DDL: no dollar-quoted bodies and no explicit
 * BEGIN/COMMIT/ROLLBACK (the runner refuses them loudly). Because partial
 * application is possible, every statement in a marker file must be
 * idempotent (IF NOT EXISTS / IF EXISTS); the file is recorded only after
 * ALL statements succeed, so a re-run resumes safely. There is NO down
 * path for any migration (recorded policy, see docs/runbooks/ops.md).
 *
 * Usage: DATABASE_URL=postgres://… npm run migrate -w @agric-platform/api
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// migrate.ts lives at <repo>/apps/api/src/database (tsx) or
// <repo>/apps/api/dist/database (compiled): four levels up reaches the repo
// root where infra/postgres lives.
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres'
);

/**
 * 001_init.sql has four BEGIN/COMMIT blocks; identity.users commits in the
 * FIRST block, so probing it cannot distinguish a complete 001 from a run
 * that died mid-file. events.processed_events is created in 001's final
 * block (001_init.sql:818-823), immediately before the last COMMIT.
 */
const INIT_COMPLETE_PROBE = `SELECT to_regclass('events.processed_events') AS present`;

/**
 * Artifact probes for baseline detection, keyed by migration filename. The
 * highest-numbered probed file present on disk at runtime is used: when its
 * artifact already exists in the database, every migration up to and
 * including that file was applied out-of-band (docker-entrypoint-initdb.d
 * runs ALL of infra/postgres on first boot) and is recorded as applied
 * instead of being re-applied. Each probe must return a single row with a
 * boolean `present` column.
 */
const LATEST_ARTIFACT_PROBES: Record<string, string> = {
  '040_warehouse_certification_basis.sql': `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'warehouse'
         AND table_name = 'warehouses'
         AND column_name = 'certification_basis'
     ) AS present`,
  // L-21 hardening: track the latest migration a Compose-bootstrapped
  // database would have applied out-of-band, so the baseline records ALL
  // of them instead of re-applying 041+ (benign today — everything is
  // idempotent — but a fragile invariant for future non-idempotent DDL).
  '082_hot_path_indexes.sql': `SELECT to_regclass('marketplace.order_events_order_id_idx') AS present`
};

export interface BaselineInput {
  /** Migration files present on disk, in lexical application order. */
  files: string[];
  /** 001's final-block object (events.processed_events) exists. */
  initSchemaComplete: boolean;
  /** The artifact of `latestProbedFile` already exists in the database. */
  latestArtifactPresent: boolean;
  /** Highest-numbered on-disk file with an entry in LATEST_ARTIFACT_PROBES. */
  latestProbedFile: string | null;
}

/**
 * Decides which migration files to record as already applied when
 * schema_migrations is empty (baseline). Pure so the decision is unit-testable
 * without a database.
 */
export function baselineFilesForEmptyHistory(input: BaselineInput): string[] {
  if (input.latestArtifactPresent && input.latestProbedFile !== null) {
    return input.files.filter((file) => file <= input.latestProbedFile!);
  }
  if (input.initSchemaComplete) {
    return input.files.filter((file) => file === '001_init.sql');
  }
  return [];
}

/** Highest-numbered on-disk migration file that has an artifact probe. */
export function latestProbedFile(files: string[]): string | null {
  const probed = files.filter((file) =>
    Object.prototype.hasOwnProperty.call(LATEST_ARTIFACT_PROBES, file)
  );
  return probed.length > 0 ? probed[probed.length - 1] : null;
}

/**
 * First-line marker opting a migration file out of the per-file
 * transaction (V-76). Required for CREATE INDEX CONCURRENTLY and other
 * DDL that cannot run inside a transaction block.
 */
export const NON_TRANSACTIONAL_MARKER = '-- no-transaction';

/** True when the file's first line is the non-transactional marker. */
export function isNonTransactionalMigration(sql: string): boolean {
  const newlineAt = sql.indexOf('\n');
  const firstLine = (newlineAt === -1 ? sql : sql.slice(0, newlineAt)).trim().toLowerCase();
  return firstLine === NON_TRANSACTIONAL_MARKER;
}

/**
 * Splits a marker file into individual statements. Conservative by
 * contract: marker files may contain ONLY flat DDL — no dollar-quoted
 * function bodies (semicolons inside $$ would be split incorrectly) and no
 * explicit transaction control (defeats the marker's purpose). Violations
 * fail loudly here instead of corrupting a production run.
 */
export function splitNonTransactionalStatements(sql: string, file: string): string[] {
  if (sql.includes('$$')) {
    throw new Error(
      `${file}: non-transactional migrations must not contain dollar-quoted bodies — split the work into a transactional file`
    );
  }
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im.test(sql)) {
    throw new Error(
      `${file}: non-transactional migrations must not contain BEGIN/COMMIT/ROLLBACK — the runner applies each statement individually`
    );
  }
  // Strip line comments BEFORE splitting on ';' — a semicolon inside a
  // `-- …` comment (e.g. "lot→animals; the reverse lookup…" in 082) would
  // otherwise split the comment mid-line and leak the remainder into the
  // next statement as bare text (CI db-contract failure, 2026-09-18).
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const commentAt = line.indexOf('--');
      return commentAt === -1 ? line : line.slice(0, commentAt);
    })
    .join('\n');
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const applied = new Set(
      (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (row) => row.filename
      )
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    // Baseline: docker-entrypoint-initialised databases already ran some or
    // all of the migrations without a migrations table.
    if (applied.size === 0) {
      const probedFile = latestProbedFile(files);
      let latestArtifactPresent = false;
      if (probedFile !== null) {
        const probe = await pool.query<{ present: boolean }>(LATEST_ARTIFACT_PROBES[probedFile]);
        latestArtifactPresent = probe.rows[0]?.present === true;
      }
      const initProbe = await pool.query<{ present: string | null }>(INIT_COMPLETE_PROBE);
      const baseline = baselineFilesForEmptyHistory({
        files,
        initSchemaComplete: initProbe.rows[0]?.present != null,
        latestArtifactPresent,
        latestProbedFile: probedFile
      });
      for (const file of baseline) {
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        applied.add(file);
      }
      if (baseline.length > 0) {
        console.log(
          `migrate: recorded existing baseline (${baseline[0]} … ${baseline[baseline.length - 1]}, ${baseline.length} file(s))`
        );
      }
    }

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`migrate: skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      if (isNonTransactionalMigration(sql)) {
        const statements = splitNonTransactionalStatements(sql, file);
        console.log(
          `migrate: applying ${file} … (non-transactional, ${statements.length} statement(s))`
        );
        for (const [index, statement] of statements.entries()) {
          await pool.query(statement);
          console.log(`migrate: ${file} statement ${index + 1}/${statements.length} applied`);
        }
      } else {
        console.log(`migrate: applying ${file} …`);
        await pool.query(sql);
      }
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`migrate: applied ${file}`);
    }
    console.log('migrate: up to date');
  } finally {
    await pool.end();
  }
}

// Run only when invoked directly (`tsx src/database/migrate.ts`), not when a
// test imports the baseline decision helpers.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`migrate: FAILED — ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
