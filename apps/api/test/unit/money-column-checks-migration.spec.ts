import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, toSql } from 'pgsql-ast-parser';

/**
 * Migration 044 (money/quantity CHECK constraints beyond agent_banking)
 * structural checks — the same parser lint:sql uses, asserting every CHECK
 * lands on the right table with the right expression, and that each
 * ADD CONSTRAINT is preceded by the sanctioned DROP CONSTRAINT IF EXISTS
 * (016 pattern) so the file is re-apply-safe.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '044_money_column_checks.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const statements = parse(sql);

/** table -> [constraintName, normalised CHECK rendering] */
const EXPECTED_CHECKS: Record<string, Array<[string, string]>> = {
  'input_vouchers.programmes': [
    ['programmes_per_farmer_cap_kobo_check', 'per_farmer_cap_kobo>0'],
    ['programmes_budget_kobo_check', 'budget_kobo>0']
  ],
  'input_vouchers.vouchers': [['vouchers_amount_kobo_check', 'amount_kobo>0']],
  'input_vouchers.redemptions': [['redemptions_amount_kobo_check', 'amount_kobo>0']],
  'vsla_carbon.vsla_contributions': [['vsla_contributions_amount_kobo_check', 'amount_kobo>0']],
  'vsla_carbon.vsla_share_outs': [
    ['vsla_share_outs_share_kobo_check', 'share_kobo>=0'],
    ['vsla_share_outs_contributed_kobo_check', 'contributed_kobo>=0'],
    ['vsla_share_outs_residual_kobo_check', 'residual_kobo>=0']
  ],
  'vsla_carbon.vsla_loans': [
    ['vsla_loans_principal_kobo_check', 'principal_kobo>0'],
    ['vsla_loans_interest_rate_bps_check', 'interest_rate_bps>=0'],
    ['vsla_loans_total_due_kobo_check', 'total_due_kobo>0'],
    ['vsla_loans_repaid_kobo_check', 'repaid_kobo>=0ANDrepaid_kobo<=total_due_kobo']
  ],
  'vsla_carbon.vsla_loan_repayments': [
    ['vsla_loan_repayments_amount_kobo_check', 'amount_kobo>0']
  ],
  'marketplace.listings': [['listings_price_ngn_check', 'price_ngnISNULLORprice_ngn>=0']],
  'marketplace.buyer_requests': [
    ['buyer_requests_max_price_ngn_check', 'max_price_ngnISNULLORmax_price_ngn>=0']
  ],
  'marketplace.orders': [
    ['orders_quantity_check', 'quantity>0'],
    ['orders_total_naira_check', 'total_naira>=0']
  ],
  'services.offerings': [['offerings_price_naira_check', 'price_naira>=0']],
  'services.bookings': [
    ['bookings_quantity_check', 'quantity>0'],
    ['bookings_total_naira_check', 'total_naira>=0']
  ]
};

interface AlterChange {
  type: string;
  ifExists?: boolean;
  constraint?: { name?: string; constraintName?: { name: string }; expr?: unknown };
}

function alterChanges(): Array<{ table: string; change: AlterChange }> {
  const out: Array<{ table: string; change: AlterChange }> = [];
  for (const statement of statements) {
    if (statement.type !== 'alter table') continue;
    const table = `${statement.table.schema ? statement.table.schema + '.' : ''}${statement.table.name}`;
    for (const change of statement.changes as unknown as AlterChange[]) {
      out.push({ table, change });
    }
  }
  return out;
}

function normalise(expr: unknown): string {
  // toSql renders deterministically with extra parens/spaces; strip both.
  return toSql
    .expr(expr as never)
    .replace(/[()\s]/g, '');
}

describe('infra/postgres/044_money_column_checks.sql', () => {
  it('parses cleanly with pgsql-ast-parser', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it('adds every expected CHECK constraint on the right table with the right expression', () => {
    const adds = alterChanges().filter(({ change }) => change.type === 'add constraint');
    for (const [table, checks] of Object.entries(EXPECTED_CHECKS)) {
      for (const [name, expectedExpr] of checks) {
        const match = adds.find(
          ({ table: t, change }) => t === table && change.constraint?.constraintName?.name === name
        );
        expect(match, `${name} on ${table}`).toBeDefined();
        expect(normalise(match!.change.constraint?.expr), `${name} expression`).toBe(expectedExpr);
      }
    }
    // No unexpected constraints slipped in.
    const expectedNames = new Set(
      Object.values(EXPECTED_CHECKS)
        .flat()
        .map(([name]) => name)
    );
    for (const { change } of adds) {
      expect(expectedNames.has(change.constraint?.constraintName?.name ?? '')).toBe(true);
    }
  });

  it('every ADD CONSTRAINT is preceded by DROP CONSTRAINT IF EXISTS of the same name (016 pattern)', () => {
    const changes = alterChanges();
    const dropped = new Set<string>();
    for (const { change } of changes) {
      if (change.type === 'drop constraint') {
        expect(change.ifExists).toBe(true);
        dropped.add(change.constraint?.name ?? '');
      }
      if (change.type === 'add constraint') {
        const name = change.constraint?.constraintName?.name ?? '';
        expect(dropped.has(name), `DROP CONSTRAINT IF EXISTS ${name} precedes its ADD`).toBe(true);
      }
    }
  });

  it('contains only BEGIN/COMMIT and ALTER TABLE statements', () => {
    const allowed = new Set(['begin', 'commit', 'alter table']);
    for (const statement of statements) {
      expect(allowed.has(statement.type)).toBe(true);
    }
  });
});
