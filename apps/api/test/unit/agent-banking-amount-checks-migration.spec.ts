import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'pgsql-ast-parser';

/**
 * Migration 041 (agent-banking amount CHECK constraints) structural checks —
 * the same parser lint:sql uses, plus the Stage 21 guarantees:
 * positivity CHECKs land on float_topups.amount_kobo, vouchers.amount_kobo
 * and transactions.amount_kobo, a non-negativity CHECK lands on
 * transactions.commission_kobo, and every ALTER is idempotent
 * (DROP CONSTRAINT IF EXISTS before ADD) per migration policy.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '041_agent_banking_amount_checks.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const statements = parse(sql);

interface AlterTableStatement {
  type: 'alter table';
  table: { schema?: string; name: string };
  changes: Array<{
    type: string;
    ifExists?: boolean;
    constraint?: {
      name?: string;
      constraintName?: { name?: string };
      type: string;
      expr?: unknown;
    };
  }>;
}

const alters = statements.filter(
  (statement): statement is AlterTableStatement =>
    statement.type === 'alter table'
);

const addedChecks = alters.flatMap((statement) =>
  statement.changes
    .filter((change) => change.type === 'add constraint')
    .map((change) => ({
      schema: statement.table.schema,
      table: statement.table.name,
      name: change.constraint?.constraintName?.name,
      expr: change.constraint?.expr
    }))
);

const droppedConstraints = alters.flatMap((statement) =>
  statement.changes
    .filter((change) => change.type === 'drop constraint')
    .map((change) => ({
      table: statement.table.name,
      name: change.constraint?.name,
      ifExists: change.ifExists
    }))
);

describe('infra/postgres/041_agent_banking_amount_checks.sql', () => {
  it('parses cleanly with pgsql-ast-parser', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it('adds a positivity CHECK on agent_banking.float_topups.amount_kobo', () => {
    const check = addedChecks.find(
      (entry) => entry.schema === 'agent_banking' && entry.table === 'float_topups'
    );
    expect(check?.name).toBe('float_topups_amount_positive');
    expect(sql).toContain('CHECK (amount_kobo > 0)');
  });

  it('adds a positivity CHECK on agent_banking.vouchers.amount_kobo', () => {
    const check = addedChecks.find(
      (entry) => entry.schema === 'agent_banking' && entry.table === 'vouchers'
    );
    expect(check?.name).toBe('vouchers_amount_positive');
  });

  it('adds positivity and commission CHECKs on agent_banking.transactions', () => {
    const names = addedChecks
      .filter(
        (entry) => entry.schema === 'agent_banking' && entry.table === 'transactions'
      )
      .map((entry) => entry.name);
    expect(names).toContain('transactions_amount_positive');
    expect(names).toContain('transactions_commission_nonnegative');
    expect(sql).toContain('CHECK (commission_kobo >= 0)');
  });

  it('is idempotent: every ADD CONSTRAINT is preceded by DROP CONSTRAINT IF EXISTS', () => {
    const addedNames = addedChecks.map((entry) => entry.name).sort();
    const droppedNames = droppedConstraints
      .filter((entry) => entry.ifExists === true)
      .map((entry) => entry.name)
      .sort();
    expect(droppedNames).toEqual(addedNames);
  });

  it('targets exactly the three agent_banking money tables', () => {
    const tables = [...new Set(alters.map((statement) => statement.table.name))].sort();
    expect(tables).toEqual(['float_topups', 'transactions', 'vouchers']);
  });
});
