/**
 * Migration runner (persistence wave plan §3.1). Applies infra/postgres/*.sql
 * in lexical order, recording each file in schema_migrations(filename PK,
 * applied_at). Idempotent: already-applied files are skipped.
 *
 * Baseline detection: databases initialised by docker-entrypoint-initdb.d
 * already ran 001_init.sql without a migrations table; when
 * schema_migrations is empty but identity.users exists, 001 is recorded as
 * the baseline instead of being re-applied.
 *
 * Usage: DATABASE_URL=postgres://… npm run migrate -w @agric-platform/api
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const BASELINE_PROBE = `SELECT to_regclass('identity.users') AS existing`;

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

    // Baseline: docker-entrypoint-initialised databases already contain the
    // 001 schema but no migrations table.
    if (applied.size === 0) {
      const probe = await pool.query<{ existing: string | null }>(BASELINE_PROBE);
      if (probe.rows[0]?.existing) {
        await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [
          '001_init.sql'
        ]);
        applied.add('001_init.sql');
        console.log('migrate: recorded existing 001_init.sql baseline');
      }
    }

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`migrate: skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`migrate: applying ${file} …`);
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`migrate: applied ${file}`);
    }
    console.log('migrate: up to date');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`migrate: FAILED — ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
