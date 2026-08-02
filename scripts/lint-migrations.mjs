#!/usr/bin/env node
/**
 * Migration lint (persistence wave plan §9.3). Parses every
 * infra/postgres/*.sql file with pgsql-ast-parser and asserts:
 *   - clean parse (syntax errors fail the build before docker first-boot does)
 *   - no unguarded DROP TABLE / DROP SCHEMA / TRUNCATE statements
 *   - every CREATE TABLE declares a primary key (inline or table-level)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'pgsql-ast-parser';

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

/** CREATE TABLE statements whose primary key check is skipped (join tables). */
function hasPrimaryKey(statement) {
  if (statement.type !== 'create table') return true;
  const columns = statement.columns ?? [];
  const columnPk = columns.some((column) =>
    (column.constraints ?? []).some((constraint) => constraint.type === 'primary key')
  );
  const tablePk = (statement.constraints ?? []).some(
    (constraint) => constraint.type === 'primary key'
  );
  return columnPk || tablePk;
}

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  let statements;
  try {
    statements = parse(sql);
  } catch (error) {
    fail(file, `parse error — ${error.message}`);
    continue;
  }
  for (const statement of statements) {
    if (statement.type === 'drop table' || statement.type === 'drop schema') {
      if (!statement.ifExists) {
        fail(file, `unguarded ${statement.type.toUpperCase()} (${statement.name?.name ?? '?'})`);
      }
    }
    if (statement.type === 'truncate table') {
      fail(file, 'TRUNCATE is not allowed in migrations');
    }
    if (statement.type === 'create table') {
      const name = `${statement.name.schema ? statement.name.schema + '.' : ''}${statement.name.name}`;
      if (!hasPrimaryKey(statement)) {
        fail(file, `CREATE TABLE ${name} has no primary key`);
      }
    }
  }
  console.log(`lint:sql ${file}: ${statements.length} statements parsed`);
}

if (failures > 0) {
  console.error(`lint:sql FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log(`lint:sql OK (${files.length} migration file(s))`);
