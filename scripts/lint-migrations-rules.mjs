/**
 * Migration lint rules (persistence wave plan §9.3), factored out of
 * lint-migrations.mjs so they are unit-testable. Input is the parsed
 * pgsql-ast-parser statement list for one migration file; output is a list of
 * human-readable problem strings (empty = clean).
 *
 * Rules:
 *   - no unguarded DROP TABLE / DROP SCHEMA / TRUNCATE statements
 *   - DROP INDEX must be IF EXISTS
 *   - no ALTER TABLE … DROP COLUMN (data-loss DDL is not migration-safe)
 *   - no unguarded ALTER TABLE … DROP CONSTRAINT (must be IF EXISTS)
 *   - ALTER TABLE … ADD CONSTRAINT must be re-apply-safe: preceded in the
 *     same file by DROP CONSTRAINT IF EXISTS of the same name (016 pattern)
 *     or guarded by a pg_constraint DO block that names BOTH the constraint
 *     and its table (019a pattern; the DO block body is opaque to the
 *     parser, so the heuristic is a name+table mention — table-qualified so
 *     a same-named constraint on another table does not satisfy it, A4-12)
 *   - ALTER TABLE … ADD COLUMN must use IF NOT EXISTS or be guarded by an
 *     information_schema.columns DO block naming the column and its table
 *   - ALTER COLUMN … TYPE (SET DATA TYPE) is never allowed — it rewrites and
 *     locks the whole table; add a new column + backfill + swap instead
 *   - CREATE TABLE must use IF NOT EXISTS
 *   - every CREATE TABLE declares a primary key (inline or table-level)
 *   - CREATE INDEX / CREATE UNIQUE INDEX must use IF NOT EXISTS (a
 *     mid-file-failed migration must be re-applyable end to end)
 *   - CREATE SCHEMA / CREATE EXTENSION must use IF NOT EXISTS
 *   - CREATE TYPE (enum or composite) has no IF NOT EXISTS in Postgres — it
 *     must be guarded by a pg_type DO block naming the type
 *   - data DML must be re-apply-safe: INSERT requires ON CONFLICT (003/021
 *     seed pattern); DELETE is not allowed in migrations; UPDATE is allowed
 *     only as a self-guarding null-backfill (SET c = … WHERE c IS NULL,
 *     the 018 pattern, which is a provable no-op on re-apply)
 */

/** CREATE TABLE primary key check (inline or table-level constraint). */
function hasPrimaryKey(statement) {
  const columns = statement.columns ?? [];
  const columnPk = columns.some((column) =>
    (column.constraints ?? []).some((constraint) => constraint.type === 'primary key')
  );
  const tablePk = (statement.constraints ?? []).some(
    (constraint) => constraint.type === 'primary key'
  );
  return columnPk || tablePk;
}

function tableName(name) {
  return `${name.schema ? name.schema + '.' : ''}${name.name}`;
}

/**
 * True when a DO-block body plausibly guards `name` on `table` via the
 * given catalog (pg_constraint / information_schema.columns / pg_type). The
 * body must mention the catalog, the object name AND the table's bare name,
 * so a same-named object on a different table (or a stray comment mention)
 * does not satisfy the guard (A4-12).
 */
function doBlockGuards(body, catalog, name, table) {
  return body.includes(catalog) && body.includes(name) && (!table || body.includes(table));
}

/** Recursively search an expression AST for `<column> IS NULL`. */
function hasIsNullGuard(node, column) {
  if (!node || typeof node !== 'object') {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((child) => hasIsNullGuard(child, column));
  }
  if (
    node.type === 'unary' &&
    node.op === 'IS NULL' &&
    node.operand?.type === 'ref' &&
    node.operand?.name === column
  ) {
    return true;
  }
  return Object.values(node).some((value) => hasIsNullGuard(value, column));
}

/**
 * The only UPDATE allowed in a migration: a self-guarding backfill that
 * sets a column only where that column IS NULL (018 pattern). Re-applying
 * it is a no-op because the backfilled rows no longer match the predicate.
 */
function isSelfGuardingBackfill(statement) {
  const where = statement.where;
  if (!where) {
    return false;
  }
  return (statement.sets ?? []).some(
    (set) => set.column?.name && hasIsNullGuard(where, set.column.name)
  );
}

export function lintMigrationStatements(statements) {
  const problems = [];
  const droppedConstraintIfExists = new Set();
  const doBlockBodies = statements
    .filter((statement) => statement.type === 'do')
    .map((statement) => statement.code ?? '');

  for (const statement of statements) {
    if (statement.type === 'drop table' || statement.type === 'drop schema') {
      if (!statement.ifExists) {
        problems.push(`unguarded ${statement.type.toUpperCase()} (${statement.name?.name ?? '?'})`);
      }
    }
    if (statement.type === 'drop index' && !statement.ifExists) {
      problems.push(
        `DROP INDEX (${(statement.names ?? []).map((name) => name.name).join(', ') || '?'}) without IF EXISTS — add IF EXISTS so a re-applied migration does not fail on the missing index`
      );
    }
    if (statement.type === 'truncate table') {
      problems.push('TRUNCATE is not allowed in migrations');
    }
    if (statement.type === 'create schema' && !statement.ifNotExists) {
      problems.push(
        `CREATE SCHEMA ${statement.name?.name ?? '?'} without IF NOT EXISTS — add IF NOT EXISTS so a re-applied migration does not fail on the existing schema`
      );
    }
    if (statement.type === 'create extension' && !statement.ifNotExists) {
      problems.push(
        `CREATE EXTENSION ${statement.extension?.name ?? '?'} without IF NOT EXISTS — add IF NOT EXISTS so a re-applied migration does not fail on the existing extension`
      );
    }
    if (statement.type === 'create enum' || statement.type === 'create composite type') {
      const name = statement.name?.name ?? '?';
      if (!doBlockBodies.some((body) => doBlockGuards(body, 'pg_type', name))) {
        problems.push(
          `CREATE TYPE ${name} without an existence guard — Postgres has no IF NOT EXISTS for types; wrap it in a DO block testing pg_type (IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') …)`
        );
      }
    }
    if (statement.type === 'create table') {
      const name = tableName(statement.name);
      if (!statement.ifNotExists) {
        problems.push(`CREATE TABLE ${name} without IF NOT EXISTS`);
      }
      if (!hasPrimaryKey(statement)) {
        problems.push(`CREATE TABLE ${name} has no primary key`);
      }
    }
    if (statement.type === 'create index') {
      if (!statement.ifNotExists) {
        const kind = statement.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
        const name = statement.indexName?.name ?? '?';
        const on = statement.table ? tableName(statement.table) : '?';
        problems.push(
          `${kind} ${name} ON ${on} without IF NOT EXISTS — add IF NOT EXISTS so a re-applied migration does not fail on the existing index`
        );
      }
    }
    if (statement.type === 'insert' && !statement.onConflict) {
      problems.push(
        `INSERT INTO ${tableName(statement.into)} without ON CONFLICT — seed/backfill data must be re-apply-safe: add ON CONFLICT (<key>) DO NOTHING (003/021 pattern)`
      );
    }
    if (statement.type === 'update' && !isSelfGuardingBackfill(statement)) {
      problems.push(
        `UPDATE ${tableName(statement.table)} is not provably idempotent — data DML in a migration must be a self-guarding null-backfill (SET c = … WHERE c IS NULL, the 018 pattern) so re-apply is a no-op`
      );
    }
    if (statement.type === 'delete') {
      problems.push(
        `DELETE FROM ${tableName(statement.from)} is not allowed in migrations — data deletion belongs in a retention job, not a one-shot migration`
      );
    }
    if (statement.type === 'alter table') {
      const table = tableName(statement.table);
      for (const change of statement.changes ?? []) {
        if (change.type === 'drop column') {
          problems.push(
            `ALTER TABLE ${table} DROP COLUMN (${change.column?.name ?? '?'}) is not allowed in migrations`
          );
        }
        if (change.type === 'add column') {
          const column = change.column?.name?.name ?? change.column?.name ?? '?';
          if (
            !change.ifNotExists &&
            !doBlockBodies.some((body) =>
              doBlockGuards(body, 'information_schema.columns', column, statement.table?.name)
            )
          ) {
            problems.push(
              `ALTER TABLE ${table} ADD COLUMN ${column} without IF NOT EXISTS — add IF NOT EXISTS (or guard with an information_schema.columns DO block) so a re-applied migration does not fail on the existing column`
            );
          }
        }
        if (change.type === 'alter column' && change.alter?.type === 'set type') {
          problems.push(
            `ALTER TABLE ${table} ALTER COLUMN ${change.column?.name ?? '?'} TYPE is not allowed in migrations — changing a column type rewrites and locks the whole table; add a new column, backfill it, then swap`
          );
        }
        if (change.type === 'drop constraint') {
          const name = change.constraint?.name ?? '?';
          if (!change.ifExists) {
            problems.push(
              `ALTER TABLE ${table} DROP CONSTRAINT ${name} without IF EXISTS`
            );
          } else {
            droppedConstraintIfExists.add(name);
          }
        }
        if (change.type === 'add constraint') {
          const name = change.constraint?.constraintName?.name;
          if (!name) {
            problems.push(
              `ALTER TABLE ${table} ADD CONSTRAINT without a constraint name — name it and guard re-apply`
            );
          } else if (
            !droppedConstraintIfExists.has(name) &&
            !doBlockBodies.some((body) =>
              doBlockGuards(body, 'pg_constraint', name, statement.table?.name)
            )
          ) {
            problems.push(
              `ALTER TABLE ${table} ADD CONSTRAINT ${name} is not re-apply-safe: precede it with DROP CONSTRAINT IF EXISTS (016 pattern) or guard it in a pg_constraint DO block naming both the constraint and ${statement.table?.name ?? table} (019a pattern)`
            );
          }
        }
      }
    }
  }
  return problems;
}
