import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'pgsql-ast-parser';

/**
 * Migration 074 (idempotency payload fingerprints, Stage 27 WP-G11, V2
 * audit): structural guarantees — additive nullable payload_hash columns on
 * the five idempotency-keyed operational tables (nullable so pre-074 rows
 * replay as legacy without a backfill), every statement is IF NOT EXISTS
 * idempotent, and nothing touches merged migrations or adds triggers.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../..', 'infra/postgres');
const MIGRATION_FILE = join(
  MIGRATIONS_DIR,
  '074_idempotency_payload_hash.sql'
);

const EXPECTED_TABLES = [
  'vsla_carbon.vsla_contributions',
  'agent_banking.float_topups',
  'agent_banking.vouchers',
  'agent_banking.transactions',
  'marketplace.orders'
] as const;

describe('infra/postgres/074_idempotency_payload_hash.sql', () => {
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  const statements = parse(sql);

  it('adds nullable payload_hash text columns to exactly the five idempotency-keyed tables', () => {
    const alters = statements.filter((stmt) => stmt.type === 'alter table');
    expect(alters).toHaveLength(5);
    const seen = new Set<string>();
    for (const stmt of alters) {
      if (stmt.type !== 'alter table') continue;
      const tableName = `${stmt.table.schema}.${stmt.table.name}`;
      seen.add(tableName);
      expect(stmt.changes).toHaveLength(1);
      const change = stmt.changes[0];
      expect(change.type).toBe('add column');
      if (change.type !== 'add column') continue;
      expect(change.ifNotExists).toBe(true);
      expect(change.column.name).toBe('payload_hash');
      expect(change.column.dataType).toMatchObject({ kind: 'text' });
      // Nullable: no NOT NULL constraint (legacy rows replay without hash).
      expect(change.column.constraints ?? []).toHaveLength(0);
    }
    expect([...seen].sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('is wrapped in a single transaction and contains no triggers or destructive statements', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    const types = new Set(statements.map((stmt) => stmt.type));
    expect([...types]).toEqual(['alter table']);
    expect(sql.toUpperCase()).not.toContain('TRIGGER');
    expect(sql.toUpperCase()).not.toContain('DROP ');
  });

  it('keeps the highest migration number on the branch (074 free after WP-G13 declined it)', () => {
    const numbers = readdirSync(MIGRATIONS_DIR)
      .map((name) => /^(\d+)_/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number.parseInt(value, 10));
    expect(Math.max(...numbers)).toBe(74);
  });
});
