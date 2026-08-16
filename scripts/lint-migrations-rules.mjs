/**
 * Migration lint rules (persistence wave plan §9.3), factored out of
 * lint-migrations.mjs so they are unit-testable. Input is the parsed
 * pgsql-ast-parser statement list for one migration file; output is a list of
 * human-readable problem strings (empty = clean).
 *
 * Rules:
 *   - no unguarded DROP TABLE / DROP SCHEMA / TRUNCATE statements
 *   - no ALTER TABLE … DROP COLUMN (data-loss DDL is not migration-safe)
 *   - no unguarded ALTER TABLE … DROP CONSTRAINT (must be IF EXISTS)
 *   - ALTER TABLE … ADD CONSTRAINT must be re-apply-safe: preceded in the
 *     same file by DROP CONSTRAINT IF EXISTS of the same name (016 pattern)
 *     or guarded by a pg_constraint DO block mentioning the constraint name
 *     (019a pattern; the DO block body is opaque to the parser, so the
 *     heuristic is a name mention)
 *   - CREATE TABLE must use IF NOT EXISTS
 *   - every CREATE TABLE declares a primary key (inline or table-level)
 *   - CREATE INDEX / CREATE UNIQUE INDEX must use IF NOT EXISTS (a
 *     mid-file-failed migration must be re-applyable end to end)
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
    if (statement.type === 'truncate table') {
      problems.push('TRUNCATE is not allowed in migrations');
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
    if (statement.type === 'alter table') {
      const table = tableName(statement.table);
      for (const change of statement.changes ?? []) {
        if (change.type === 'drop column') {
          problems.push(
            `ALTER TABLE ${table} DROP COLUMN (${change.column?.name ?? '?'}) is not allowed in migrations`
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
            !doBlockBodies.some((body) => body.includes(name))
          ) {
            problems.push(
              `ALTER TABLE ${table} ADD CONSTRAINT ${name} is not re-apply-safe: precede it with DROP CONSTRAINT IF EXISTS (016 pattern) or guard it in a pg_constraint DO block (019a pattern)`
            );
          }
        }
      }
    }
  }
  return problems;
}
