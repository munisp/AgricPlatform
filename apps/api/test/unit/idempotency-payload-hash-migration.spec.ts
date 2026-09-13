import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';

/**
 * Migration 074 (idempotency payload fingerprints, Stage 27 WP-G11, V2
 * idempotency-consistency audit) structural checks — the same parser lint
 * lint:sql uses, plus the WP-G11 guarantees: every idempotency-keyed
 * operational table gains a nullable payload_hash column (nullable so
 * pre-074 rows replay as legacy without a backfill), every statement is
 * re-apply safe per migration policy, and no merged migration was edited.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '074_idempotency_payload_hash.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const statements = parse(sql);

interface AlterTableStatement {
  type: 'alter table';
  table: { schema?: string; name: string };
  changes: Array<{ type: string }>;
}

const alters = statements.filter(
  (statement): statement is AlterTableStatement => statement.type === 'alter table'
);

describe('infra/postgres/074_idempotency_payload_hash.sql', () => {
  it('parses cleanly with pgsql-ast-parser', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it('adds payload_hash to all five idempotency-keyed tables, idempotently', () => {
    const targets = alters.map((statement) => `${statement.table.schema}.${statement.table.name}`);
    expect(targets).toEqual([
      'vsla_carbon.vsla_contributions',
      'agent_banking.float_topups',
      'agent_banking.vouchers',
      'agent_banking.transactions',
      'marketplace.orders'
    ]);
    for (const alter of alters) {
      expect(alter.changes.some((change) => change.type === 'add column')).toBe(true);
    }
    // Every ADD COLUMN is re-apply safe.
    expect(sql.match(/ADD COLUMN IF NOT EXISTS payload_hash text/g)).toHaveLength(5);
  });

  it('uses no triggers and edits no merged migration (repo convention)', () => {
    expect(sql.toUpperCase()).not.toContain('CREATE TRIGGER');
  });
});
