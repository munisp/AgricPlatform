import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';

/**
 * Migration 028 (geo-verified credit shadow scores) structural checks —
 * the same parser lint:sql uses, plus the wave-specific guarantees:
 * idempotent (IF NOT EXISTS everywhere), primary key present, and the
 * (application_id, input_fingerprint) uniqueness that batch recompute
 * idempotency relies on.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '028_geocredit.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const statements = parse(sql);

describe('infra/postgres/028_geocredit.sql', () => {
  it('parses cleanly with pgsql-ast-parser', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it('creates credit.geo_credit_shadow_scores idempotently with a primary key', () => {
    const table = statements.find(
      (statement) =>
        statement.type === 'create table' &&
        statement.name.schema === 'credit' &&
        statement.name.name === 'geo_credit_shadow_scores'
    );
    expect(table).toBeDefined();
    if (table?.type !== 'create table') throw new Error('unreachable');
    expect(table.ifNotExists).toBe(true);
    const hasPk = table.columns.some((column) =>
      (column.constraints ?? []).some((constraint) => constraint.type === 'primary key')
    );
    expect(hasPk).toBe(true);
    const columns = table.columns.map((column) => column.name.name);
    for (const required of [
      'application_id',
      'factor_score',
      'status',
      'breakdown',
      'basis',
      'input_fingerprint',
      'computed_at'
    ]) {
      expect(columns).toContain(required);
    }
  });

  it('enforces unique (application_id, input_fingerprint) for recompute idempotency', () => {
    const uniqueIndex = statements.find(
      (statement) =>
        statement.type === 'create index' &&
        statement.unique === true &&
        statement.table.name === 'geo_credit_shadow_scores'
    );
    expect(uniqueIndex).toBeDefined();
    if (uniqueIndex?.type !== 'create index') throw new Error('unreachable');
    expect(uniqueIndex.ifNotExists).toBe(true);
    const columns = uniqueIndex.expressions.map((entry) =>
      entry.expression.type === 'ref' ? entry.expression.name : undefined
    );
    expect(columns).toEqual(['application_id', 'input_fingerprint']);
  });

  it('every CREATE statement is idempotent (IF NOT EXISTS)', () => {
    const creates = statements.filter(
      (statement) => statement.type === 'create table' || statement.type === 'create index'
    );
    expect(creates.length).toBeGreaterThanOrEqual(3);
    for (const statement of creates) {
      expect(statement.ifNotExists).toBe(true);
    }
  });

  it('contains no triggers, functions or extensions (plain SQL only)', () => {
    const allowed = new Set(['begin', 'commit', 'create table', 'create index']);
    for (const statement of statements) {
      expect(allowed.has(statement.type)).toBe(true);
    }
  });
});
