#!/usr/bin/env node
/**
 * Migration lint (persistence wave plan §9.3). Parses every
 * infra/postgres/*.sql file with pgsql-ast-parser and asserts the rules in
 * scripts/lint-migrations-rules.mjs:
 *   - clean parse (syntax errors fail the build before docker first-boot does)
 *   - no unguarded DROP TABLE / DROP SCHEMA / TRUNCATE statements
 *   - no ALTER TABLE … DROP COLUMN; DROP CONSTRAINT must be IF EXISTS
 *   - ADD CONSTRAINT must be re-apply-safe (016 DROP+ADD / 019a DO-block patterns)
 *   - CREATE TABLE must use IF NOT EXISTS and declare a primary key
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'pgsql-ast-parser';
import { lintMigrationStatements } from './lint-migrations-rules.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'postgres');

const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('lint:sql — no migration files found under infra/postgres');
  process.exit(1);
}

let failures = 0;
const fail = (file, message) => {
  failures += 1;
  console.error(`lint:sql ${file}: ${message}`);
};

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  let statements;
  try {
    statements = parse(sql);
  } catch (error) {
    fail(file, `parse error — ${error.message}`);
    continue;
  }
  for (const problem of lintMigrationStatements(statements)) {
    fail(file, problem);
  }
  console.log(`lint:sql ${file}: ${statements.length} statements parsed`);
}

if (failures > 0) {
  console.error(`lint:sql FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log(`lint:sql OK (${files.length} migration file(s))`);
