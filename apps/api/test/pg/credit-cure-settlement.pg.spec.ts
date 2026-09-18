import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { PgLedgerEntryRepository } from '../../src/database/repositories/ledger.pg-repository.js';
import {
  createPgCreditLoanRepository,
  createPgCreditRepaymentRepository
} from '../../src/database/repositories/credit-suite.pg-repository.js';

/**
 * Wave-2 V-05: default cure + settlement-for-less — PostgreSQL contract.
 *
 * Two layers, mirroring the 047/048/052/WP-G13 pg patterns:
 *  - `pg credit cure/settlement (query spy)`: always-on tests over a fake
 *    pool proving (i) the cure transition (defaulted → repaying) is a
 *    guarded compare-and-set whose WHERE clause pins BOTH the status and
 *    the updatedAt discriminator, and a lost CAS surfaces as
 *    ConflictException; and (ii) the settlement write-down posting commits
 *    only after the in-transaction transfer_is_balanced assertion, with
 *    debit legs (cash + loan_losses) summing exactly to the receivable
 *    credit (the outstanding balance).
 *  - `pg credit cure/settlement (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style (CI db-contract job), applying
 *    migrations 094–096 and driving the cure + settlement paths through the
 *    pg repositories against a real database.
 *
 *   docker compose up -d postgres
 *   npm run migrate -w @agric-platform/api
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/credit-cure-settlement.pg.spec.ts
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const query = async (text: string, params?: unknown[]) => {
    calls.push({ text, params: params ?? [] });
    const outcome = behavior(text, params ?? []);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return {
      rows: outcome.rows,
      rowCount: outcome.rowCount ?? outcome.rows.length,
      command: 'UPDATE',
      oid: 0,
      fields: []
    };
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client } as unknown as pg.Pool;
  return { pool, calls };
}

/** A defaulted loan row as credit.loan_applications would return it. */
function defaultedLoanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloan-spy',
    applicant_user_id: 'user-spy-farmer',
    product_id: 'cprd-spy',
    principal_kobo: 1_000_000,
    status: 'defaulted',
    credit_score: null,
    score_factors: null,
    purpose: null,
    group_id: null,
    plot_id: null,
    planting_id: null,
    review_flag: null,
    aging_suspended_at: null,
    consolidates_loan_id: null,
    settled_amount_kobo: null,
    write_down_kobo: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    decided_at: null,
    decided_by: null,
    ...overrides
  };
}

describe('pg credit cure/settlement (query spy)', () => {
  it('the cure CAS (defaulted → repaying) pins status AND updated_at in WHERE', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.startsWith('UPDATE credit.loan_applications')) {
        return { rows: [defaultedLoanRow({ status: 'repaying' })], rowCount: 1 };
      }
      return { rows: [] };
    });
    const repo = createPgCreditLoanRepository(pool);
    const cured = await repo.updateExpected(
      'cloan-spy',
      { status: 'repaying', updatedAt: '2026-03-01T00:00:00.000Z' },
      { status: 'defaulted', updatedAt: '2026-02-01T00:00:00.000Z' }
    );
    expect(cured.status).toBe('repaying');

    const update = calls.find((call) => call.text.startsWith('UPDATE credit.loan_applications'));
    expect(update).toBeDefined();
    expect(update!.text).toContain('WHERE id = $1');
    expect(update!.text).toContain('AND status = $');
    expect(update!.text).toContain('AND updated_at = $');
    // Expected values are bound as parameters (defaulted + the read timestamp).
    expect(update!.params).toContain('defaulted');
    expect(update!.params).toContain('2026-02-01T00:00:00.000Z');
  });

  it('a lost cure CAS (0 rows) surfaces ConflictException, never a silent overwrite', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.startsWith('UPDATE credit.loan_applications')) {
        return { rows: [], rowCount: 0 }; // the row moved: someone cured/wrote-off first
      }
      // The follow-up getById (404-contract probe) finds the row.
      if (text.includes('FROM credit.loan_applications')) {
        return { rows: [defaultedLoanRow({ status: 'written_off' })] };
      }
      return { rows: [] };
    });
    const repo = createPgCreditLoanRepository(pool);
    await expect(
      repo.updateExpected(
        'cloan-spy',
        { status: 'repaying', updatedAt: '2026-03-01T00:00:00.000Z' },
        { status: 'defaulted', updatedAt: '2026-02-01T00:00:00.000Z' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls.some((call) => call.text.startsWith('INSERT INTO events.outbox'))).toBe(false);
  });

  it('settlement write-down legs are balanced and asserted BEFORE COMMIT', async () => {
    const outstandingKobo = 1_000_000;
    const settlementKobo = 400_000;
    const writeDownKobo = outstandingKobo - settlementKobo;
    const entry: LedgerJournalEntry = {
      id: randomUUID(),
      idempotencyKey: 'credit-settlement:cloan-spy',
      referenceType: 'credit_loan_application',
      description: 'Credit settlement-for-less on defaulted loan cloan-spy',
      postedAt: new Date().toISOString(),
      postings: [
        { accountCode: 'platform:cash', direction: 'debit', amountKobo: settlementKobo },
        { accountCode: 'platform:loan_losses', direction: 'debit', amountKobo: writeDownKobo },
        {
          accountCode: 'member:user-spy-farmer:loans_receivable',
          direction: 'credit',
          amountKobo: outstandingKobo
        }
      ]
    };
    const { pool, calls } = fakePool((text) => {
      if (text.includes('finance.transfer_is_balanced')) {
        return { rows: [{ balanced: true, posting_count: 3 }] };
      }
      if (text.startsWith('SELECT id FROM finance.ledger_accounts')) {
        return { rows: [{ id: `acct-${randomUUID()}` }] };
      }
      return { rows: [] };
    });
    const repo = new PgLedgerEntryRepository(pool);
    await repo.postEntry(entry);

    // The legs as persisted: debits (cash + loan_losses) == credit (receivable).
    const postings = calls.filter((call) =>
      call.text.startsWith('INSERT INTO finance.ledger_entries')
    );
    expect(postings).toHaveLength(3);
    const debits = postings
      .filter((call) => call.params[2] === 'debit')
      .reduce((sum, call) => sum + Number(call.params[3]), 0);
    const credits = postings
      .filter((call) => call.params[2] === 'credit')
      .reduce((sum, call) => sum + Number(call.params[3]), 0);
    expect(debits).toBe(outstandingKobo);
    expect(credits).toBe(outstandingKobo);

    // In-transaction balance assertion runs after the legs, before COMMIT.
    const checkIdx = calls.findIndex((call) => call.text.includes('finance.transfer_is_balanced'));
    const lastLegIdx = calls
      .map((call, index) => ({ call, index }))
      .filter((item) => item.call.text.startsWith('INSERT INTO finance.ledger_entries'))
      .map((item) => item.index)
      .pop()!;
    const commitIdx = calls.findIndex((call) => call.text === 'COMMIT');
    expect(checkIdx).toBeGreaterThan(lastLegIdx);
    expect(commitIdx).toBeGreaterThan(checkIdx);
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(false);
  });

  it('an unbalanced settlement posting ROLLBACKs — the write-down never commits', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('finance.transfer_is_balanced')) {
        return { rows: [{ balanced: false, posting_count: 3 }] };
      }
      if (text.startsWith('SELECT id FROM finance.ledger_accounts')) {
        return { rows: [{ id: `acct-${randomUUID()}` }] };
      }
      return { rows: [] };
    });
    const repo = new PgLedgerEntryRepository(pool);
    await expect(
      repo.postEntry({
        id: randomUUID(),
        idempotencyKey: 'credit-settlement:cloan-rogue',
        referenceType: 'credit_loan_application',
        description: 'rogue settlement',
        postedAt: new Date().toISOString(),
        postings: [
          { accountCode: 'platform:loan_losses', direction: 'debit', amountKobo: 600_000 },
          {
            accountCode: 'member:user-spy-farmer:loans_receivable',
            direction: 'credit',
            amountKobo: 1_000_000
          }
        ]
      })
    ).rejects.toThrowError();
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(true);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false);
  });
});

/* ----------------------------------------------------------- live contract -- */

const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  : null;

const MIGRATIONS = ['094_credit_lifecycle_extensions.sql', '095_credit_loan_restructures.sql', '096_credit_settlement_consolidation.sql'].map(
  (name) =>
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'infra',
      'postgres',
      name
    )
);

const PREFIX = 'w2c1-v05-';
const FARMER = `${PREFIX}farmer`;
const PRODUCT = `${PREFIX}product`;
const LOAN = `${PREFIX}loan`;
const now = () => new Date().toISOString();

// Loan-scoped rows only. The shared PRODUCT/FARMER fixtures must survive a
// per-test clean — deleting the product here broke the loan INSERT's FK in
// any test that cleans first (CI db-contract failure, 2026-09-18). The
// product is rerun-safe via ON CONFLICT and torn down in afterAll.
async function clean(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM credit.loan_repayments WHERE loan_id = $1`, [LOAN]);
  await pool.query(`DELETE FROM credit.loan_restructures WHERE loan_id = $1`, [LOAN]);
  await pool.query(`DELETE FROM credit.loan_applications WHERE id = $1`, [LOAN]);
}

describePg('pg credit cure/settlement (live, migrations 094–096)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
    await pool!.query(
      `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [FARMER, '+2340000000201', 'w2c1 v05 contract farmer']
    );
    await pool!.query(
      `INSERT INTO credit.loan_products
         (id, name, min_principal_kobo, max_principal_kobo, interest_bps_annual, term_days)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [PRODUCT, 'w2c1 v05 product', 100_000, 5_000_000, 1200, 180]
    );
  });

  afterAll(async () => {
    if (pool) {
      await clean();
      await pool.query(`DELETE FROM credit.loan_products WHERE id = $1`, [PRODUCT]);
      await pool.query(`DELETE FROM identity.users WHERE id = $1`, [FARMER]);
      await pool.end();
    }
  });

  it('migrations 094–096 re-apply idempotently and expose the new surface', async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8')); // second apply must not throw
    }
    const check = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'credit' AND table_name = 'loan_applications'
         AND column_name IN ('settled_amount_kobo', 'write_down_kobo', 'consolidates_loan_id')`
    );
    expect(check.rows).toHaveLength(3);
    const repaymentCols = await pool!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'credit' AND table_name = 'loan_repayments'
         AND column_name IN ('schedule_version', 'paid_amount_kobo')`
    );
    expect(repaymentCols.rows).toHaveLength(2);
  });

  it('cure CAS on a defaulted loan succeeds once and conflicts on replay', async () => {
    await clean();
    // updated_at is written explicitly at millisecond ISO precision — exactly
    // how the repository writes rows. Relying on the column DEFAULT now()
    // stamps microseconds that the ms-precision CAS guard can never match
    // (CI db-contract failure, 2026-09-18).
    await pool!.query(
      `INSERT INTO credit.loan_applications
         (id, applicant_user_id, product_id, principal_kobo, status, updated_at)
       VALUES ($1, $2, $3, $4, 'defaulted', $5)`,
      [LOAN, FARMER, PRODUCT, 1_000_000, now()]
    );
    const loans = createPgCreditLoanRepository(pool!);
    const stored = await loans.getById(LOAN);
    expect(stored.status).toBe('defaulted');

    const cured = await loans.updateExpected(
      LOAN,
      { status: 'repaying', updatedAt: now() },
      { status: 'defaulted', updatedAt: stored.updatedAt }
    );
    expect(cured.status).toBe('repaying');
    // Replay with the stale precondition conflicts — the cure CAS is real.
    await expect(
      loans.updateExpected(
        LOAN,
        { status: 'repaying', updatedAt: now() },
        { status: 'defaulted', updatedAt: stored.updatedAt }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('settlement columns round-trip and missed installments re-activate for the cure', async () => {
    await clean();
    await pool!.query(
      `INSERT INTO credit.loan_applications
         (id, applicant_user_id, product_id, principal_kobo, status,
          settled_amount_kobo, write_down_kobo)
       VALUES ($1, $2, $3, $4, 'written_off', $5, $6)`,
      [LOAN, FARMER, PRODUCT, 1_000_000, 400_000, 659_178]
    );
    const loans = createPgCreditLoanRepository(pool!);
    const stored = await loans.getById(LOAN);
    expect(stored.settledAmountKobo).toBe(400_000);
    expect(stored.writeDownKobo).toBe(659_178);

    // Missed → pending re-activation via the repayment CAS.
    const repayments = createPgCreditRepaymentRepository(pool!);
    await repayments.create({
      id: `${PREFIX}crp-1`,
      loanId: LOAN,
      sequence: 1,
      dueAt: now(),
      amountKobo: 500_000,
      paidAmountKobo: 0,
      scheduleVersion: 1,
      status: 'missed'
    });
    const reactivated = await repayments.updateExpected(
      `${PREFIX}crp-1`,
      { status: 'pending' },
      { status: 'missed' }
    );
    expect(reactivated.status).toBe('pending');
    // 'superseded' is a legal repayment status after migration 094.
    const superseded = await repayments.updateExpected(
      `${PREFIX}crp-1`,
      { status: 'superseded' },
      { status: 'pending' }
    );
    expect(superseded.status).toBe('superseded');
  });
});
