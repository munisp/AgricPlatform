import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';

/**
 * Migration 054 (agent daily-limit counters, stage 27 WP-G2, audit A1-7)
 * structural checks — the same parser lint:sql uses, plus the WP-G2
 * guarantees: agent_banking.agent_daily_limits exists with a composite
 * (agent_id, business_date) primary key (the lock/upsert target), a
 * non-negativity CHECK on used_amount_kobo, and every statement is
 * idempotent per migration policy.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '054_agent_daily_limits.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const statements = parse(sql);

interface CreateTableStatement {
  type: 'create table';
  ifNotExists?: boolean;
  name: { schema?: string; name: string };
  columns: Array<{ name: { name: string } }>;
  constraints?: Array<{ type: string; columns?: Array<{ name: string }> }>;
}

const creates = statements.filter(
  (statement): statement is CreateTableStatement => statement.type === 'create table'
);

describe('infra/postgres/054_agent_daily_limits.sql', () => {
  it('parses cleanly with pgsql-ast-parser', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it('creates agent_banking.agent_daily_limits idempotently with the (agent_id, business_date) PK', () => {
    const table = creates.find(
      (statement) => statement.name.schema === 'agent_banking' && statement.name.name === 'agent_daily_limits'
    );
    expect(table).toBeDefined();
    expect(table!.ifNotExists).toBe(true);
    const pk = table!.constraints?.find((constraint) => constraint.type === 'primary key');
    expect(pk?.columns?.map((column) => column.name)).toEqual(['agent_id', 'business_date']);
    const columns = table!.columns.map((column) => column.name.name);
    expect(columns).toContain('agent_id');
    expect(columns).toContain('business_date');
    expect(columns).toContain('used_amount_kobo');
    expect(columns).toContain('updated_at');
  });

  it('adds a non-negativity CHECK on used_amount_kobo, re-apply safe', () => {
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS agent_daily_limits_used_nonnegative');
    expect(sql).toContain('CHECK (used_amount_kobo >= 0)');
  });

  it('references agent_banking.agents(id) so counters cannot outlive their agent', () => {
    expect(sql).toContain('REFERENCES agent_banking.agents(id)');
  });

  it('uses no triggers (repo convention)', () => {
    expect(sql.toUpperCase()).not.toContain('CREATE TRIGGER');
  });
});
