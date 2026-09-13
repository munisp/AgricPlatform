import { afterEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { PgLedgerEntryRepository } from '../../src/database/repositories/ledger.pg-repository.js';
import {
  PgVslaLoanRepository,
  PgVslaShareOutPlanRepository
} from '../../src/database/repositories/vsla-carbon.pg-repository.js';
import type { VslaShareOutPlanRecord } from '../../src/database/repositories/vsla-carbon.repository.js';

/**
 * VSLA money-path atomicity contract (WP-G1, stage-27 V2 funds-atomicity
 * audit; migration 054).
 *
 * Two layers, mirroring the 048/052 escrow-payout-claim pg patterns:
 *  - `pg vsla money path (query spy)`: always-on tests over a fake pool
 *    proving (i) the repayment claim runs on the caller-owned transaction
 *    so a failure mid-unit ROLLBACKs claim + posting + row together (no
 *    phantom REPAID), (ii) the share-out plan write is a single marker-gated
 *    transaction, and (iii) the ledger in-tx posting keeps its lock order,
 *    solvency guard and outbox insert.
 *  - `pg vsla money path (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style for CI's db-contract job with
 *    migrations through 054 applied.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params?: unknown[]) => {
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
    },
    connect: async () => {
      // The caller-owned transaction client: same spy, plus release().
      return {
        query: (text: string, params?: unknown[]) =>
          (pool as unknown as pg.Pool).query(text, params),
        release: () => undefined
      };
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

function loanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'loan-1',
    group_id: 'group-1',
    cycle_id: 'cycle-1',
    member_id: 'member-1',
    principal_kobo: 100_000,
    interest_rate_bps: 0,
    total_due_kobo: 100_000,
    repaid_kobo: 40_000,
    status: 'ACTIVE',
    issued_at: new Date().toISOString(),
    repaid_at: null,
    ledger_entry_id: 'entry-issue',
    idempotency_key: 'issue-key',
    created_at: new Date().toISOString(),
    ...overrides
  };
}

function planRow(memberId: string): VslaShareOutPlanRecord {
  return {
    id: `plan-${memberId}`,
    cycleId: 'cycle-1',
    memberId,
    shareKobo: 100_000,
    contributedKobo: 100_000,
    residualKobo: 0,
    createdAt: new Date().toISOString()
  };
}

describe('pg vsla money path (query spy)', () => {
  it('claimRepayment runs on the caller-owned tx when given (fold support)', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('UPDATE vsla_carbon.vsla_loans')) {
        return { rows: [loanRow()], rowCount: 1 };
      }
      return { rows: [] };
    });
    const repo = new PgVslaLoanRepository(pool);
    const txHandle = {
      query: (text: string, params?: unknown[]) => pool.query(text, params)
    };
    const claimed = await repo.claimRepayment('loan-1', 40_000, txHandle);
    expect(claimed?.repaidKobo).toBe(40_000);
    const update = calls.find((call) => call.text.includes('UPDATE vsla_carbon.vsla_loans'));
    expect(update?.text).toContain("status = 'ACTIVE'");
    expect(update?.text).toContain('repaid_kobo + $1 <= total_due_kobo');
    expect(update?.params).toEqual([40_000, 'loan-1']);
  });

  it('withLoanTransaction COMMITs the unit and ROLLBACKs on failure (no phantom claim)', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('UPDATE vsla_carbon.vsla_loans')) {
        return { rows: [loanRow()], rowCount: 1 };
      }
      if (text.includes('INSERT INTO vsla_carbon.vsla_loan_repayments')) {
        // Crash mid-unit: the row insert fails AFTER the claim ran.
        return new Error('connection reset');
      }
      return { rows: [] };
    });
    const repo = new PgVslaLoanRepository(pool);
    await expect(
      repo.withLoanTransaction('loan-1', async (tx) => {
        await repo.claimRepayment('loan-1', 40_000, tx);
        await pool.query(
          'INSERT INTO vsla_carbon.vsla_loan_repayments (id) VALUES ($1)',
          ['repay-1']
        );
      })
    ).rejects.toThrow('connection reset');
    const verbs = calls.map((call) => call.text.trim().split(' ')[0]);
    // BEGIN … claim … failing insert … ROLLBACK — the claim NEVER commits
    // without the rest of the unit, so no phantom REPAID can persist.
    expect(verbs).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK']);
    expect(verbs).not.toContain('COMMIT');
  });

  it('loans.create carries the idempotency key and maps 23505 to 409', async () => {
    const { pool, calls } = fakePool(() => {
      const error = new Error('duplicate key') as Error & { code?: string };
      error.code = '23505';
      return error;
    });
    const repo = new PgVslaLoanRepository(pool);
    await expect(
      repo.create({
        id: 'loan-1',
        groupId: 'group-1',
        cycleId: 'cycle-1',
        memberId: 'member-1',
        principalKobo: 100_000,
        interestRateBps: 0,
        totalDueKobo: 100_000,
        repaidKobo: 0,
        status: 'ACTIVE',
        issuedAt: new Date().toISOString(),
        ledgerEntryId: 'entry-1',
        idempotencyKey: 'client-key-1',
        createdAt: new Date().toISOString()
      })
    ).rejects.toThrow(ConflictException);
    const insert = calls.find((call) => call.text.includes('INSERT INTO vsla_carbon.vsla_loans'));
    expect(insert?.text).toContain('idempotency_key');
    expect(insert?.params).toContain('client-key-1');
  });

  it('replacePlan gates on the marker insert and commits rows + marker in ONE tx', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('INSERT INTO vsla_carbon.vsla_share_out_plan_meta')) {
        return { rows: [{ cycle_id: 'cycle-1' }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const repo = new PgVslaShareOutPlanRepository(pool);
    const applied = await repo.replacePlan(
      'cycle-1',
      [planRow('member-1'), planRow('member-2')],
      { cycleId: 'cycle-1', rowCount: 2, totalShareKobo: 200_000, createdAt: new Date().toISOString() }
    );
    expect(applied).toBe(true);
    const verbs = calls.map((call) => call.text.trim());
    expect(verbs[0]).toBe('BEGIN');
    expect(verbs[verbs.length - 1]).toBe('COMMIT');
    const marker = calls.find((call) =>
      call.text.includes('INSERT INTO vsla_carbon.vsla_share_out_plan_meta')
    );
    expect(marker?.text).toContain('ON CONFLICT DO NOTHING');
    // Partial rows are deleted before the full plan inserts.
    expect(calls.some((call) => call.text.includes('DELETE FROM vsla_carbon.vsla_share_out_plan'))).toBe(
      true
    );
    expect(
      calls.filter((call) => call.text.includes('INSERT INTO vsla_carbon.vsla_share_out_plan ('))
    ).toHaveLength(2);
  });

  it('replacePlan loses the marker race: ROLLBACK + false, no rows touched', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('INSERT INTO vsla_carbon.vsla_share_out_plan_meta')) {
        return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING skipped
      }
      return { rows: [] };
    });
    const repo = new PgVslaShareOutPlanRepository(pool);
    const applied = await repo.replacePlan(
      'cycle-1',
      [planRow('member-1')],
      { cycleId: 'cycle-1', rowCount: 1, totalShareKobo: 100_000, createdAt: new Date().toISOString() }
    );
    expect(applied).toBe(false);
    const verbs = calls.map((call) => call.text.trim().split(' ')[0]);
    expect(verbs).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
  });

  it('ledger postEntryInTx keeps lock order, solvency guard and outbox on the caller client', async () => {
    const { pool, calls } = fakePool((text) => {
      if (text.includes('SELECT id FROM finance.ledger_accounts')) {
        return { rows: [{ id: 'acct-1' }] };
      }
      if (text.includes('finance.transfer_is_balanced')) {
        // WP-G13 balanced-journal invariant: benign balanced verdict for the spy.
        return { rows: [{ balanced: true, posting_count: 2 }] };
      }
      if (text.includes('COALESCE')) {
        return { rows: [{ debits: 100_000, credits: 40_000 }] };
      }
      return { rows: [] };
    });
    const repo = new PgLedgerEntryRepository(pool);
    const entry: LedgerJournalEntry = {
      id: 'entry-1',
      idempotencyKey: 'vsla-loan-repayment:key-1',
      referenceType: 'vsla_loan_repayment',
      referenceId: 'loan-1',
      postedAt: new Date().toISOString(),
      postings: [
        { accountCode: 'vsla:group-1:cash', direction: 'debit', amountKobo: 40_000 },
        { accountCode: 'vsla:group-1:loans_receivable', direction: 'credit', amountKobo: 40_000 }
      ]
    };
    const client = { query: (text: string, params?: unknown[]) => pool.query(text, params) };
    await repo.postEntryInTx(client, entry, ['vsla:group-1:cash'], {
      id: 'event-1',
      name: 'finance.ledger.entry_posted',
      payload: { entryId: 'entry-1' },
      occurredAt: new Date().toISOString()
    });
    const texts = calls.map((call) => call.text);
    // No transaction control of its own — the caller owns BEGIN/COMMIT.
    expect(texts).not.toContain('BEGIN');
    expect(texts).not.toContain('COMMIT');
    expect(texts.some((text) => text.includes('FOR UPDATE'))).toBe(true);
    expect(texts.some((text) => text.includes('INSERT INTO finance.ledger_transfers'))).toBe(true);
    expect(texts.some((text) => text.includes('INSERT INTO events.outbox'))).toBe(true);
    expect(calls.find((call) => call.text.includes('FOR UPDATE'))?.params).toEqual([
      'vsla:group-1:cash'
    ]);
  });
});

/**
 * Live contract tests. Skipped unless DATABASE_URL points at a database with
 * migrations through 054 applied (CI db-contract job).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

describePg('pg vsla money path (live)', () => {
  const pool = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : (null as unknown as pg.Pool);

  afterEach(async () => {
    await pool.query(
      'DELETE FROM vsla_carbon.vsla_share_out_plan_meta WHERE cycle_id LIKE $1',
      ['wpg1-%']
    );
    await pool.query('DELETE FROM vsla_carbon.vsla_share_out_plan WHERE cycle_id LIKE $1', ['wpg1-%']);
  });

  it('054 marker table exists and gates replacePlan exactly once', async () => {
    await pool.query(
      "INSERT INTO vsla_carbon.vsla_groups (id, name, lead_user_id, savings_account_code, loans_receivable_account_code, interest_income_account_code) " +
        "VALUES ('wpg1-group', 'G', 'lead', 'wpg1:cash', 'wpg1:loans', 'wpg1:interest') ON CONFLICT DO NOTHING"
    );
    await pool.query(
      "INSERT INTO vsla_carbon.vsla_cycles (id, group_id, label) VALUES ('wpg1-cycle', 'wpg1-group', 'C') ON CONFLICT DO NOTHING"
    );
    const plans = new PgVslaShareOutPlanRepository(pool);
    const first = await plans.replacePlan('wpg1-cycle', [], {
      cycleId: 'wpg1-cycle',
      rowCount: 0,
      totalShareKobo: 0,
      createdAt: new Date().toISOString()
    });
    const second = await plans.replacePlan('wpg1-cycle', [], {
      cycleId: 'wpg1-cycle',
      rowCount: 0,
      totalShareKobo: 0,
      createdAt: new Date().toISOString()
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await plans.findMeta('wpg1-cycle')).toMatchObject({ cycleId: 'wpg1-cycle', rowCount: 0 });
  });

  it('a mid-unit failure commits NOTHING (no phantom claim)', async () => {
    await pool.query(
      "INSERT INTO vsla_carbon.vsla_groups (id, name, lead_user_id, savings_account_code, loans_receivable_account_code, interest_income_account_code) " +
        "VALUES ('wpg1-group2', 'G', 'lead', 'wpg1:cash2', 'wpg1:loans2', 'wpg1:interest2') ON CONFLICT DO NOTHING"
    );
    await pool.query(
      "INSERT INTO vsla_carbon.vsla_cycles (id, group_id, label) VALUES ('wpg1-cycle2', 'wpg1-group2', 'C') ON CONFLICT DO NOTHING"
    );
    await pool.query(
      "INSERT INTO vsla_carbon.vsla_members (id, group_id, user_id) VALUES ('wpg1-member2', 'wpg1-group2', 'user-1') ON CONFLICT DO NOTHING"
    );
    await pool.query(
      "INSERT INTO vsla_carbon.vsla_loans (id, group_id, cycle_id, member_id, principal_kobo, interest_rate_bps, total_due_kobo, ledger_entry_id, idempotency_key) " +
        "VALUES ('wpg1-loan2', 'wpg1-group2', 'wpg1-cycle2', 'wpg1-member2', 100000, 0, 100000, 'wpg1-entry-issue', 'wpg1-issue-key') ON CONFLICT DO NOTHING"
    );
    const loans = new PgVslaLoanRepository(pool);
    await expect(
      loans.withLoanTransaction('wpg1-loan2', async (tx) => {
        await loans.claimRepayment('wpg1-loan2', 40_000, tx);
        throw new Error('simulated crash before posting');
      })
    ).rejects.toThrow('simulated crash');
    const loan = await loans.findById('wpg1-loan2');
    expect(loan?.repaidKobo).toBe(0);
    expect(loan?.status).toBe('ACTIVE');
  });
});
