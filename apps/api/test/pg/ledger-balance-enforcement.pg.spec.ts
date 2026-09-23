import { afterEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { PgLedgerEntryRepository } from '../../src/database/repositories/ledger.pg-repository.js';

/**
 * WP-G13 (Stage 27, ledger hardening): in-transaction transfer_is_balanced
 * enforcement + the pg-level drift-detection query.
 *
 * Two layers, mirroring the 047/048/052 pg patterns:
 *  - `pg ledger balance enforcement (query spy)`: always-on tests over a
 *    fake pool proving (i) every posting runs the
 *    finance.transfer_is_balanced() assertion INSIDE the transaction after
 *    its posting rows and BEFORE COMMIT, and (ii) a failed assertion (or a
 *    <2-postings transfer) ROLLBACKs — transfer, postings and outbox event
 *    never commit.
 *  - `pg ledger balance enforcement (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style (CI db-contract job) proving the
 *    reconciliation query finds a rogue unbalanced transfer written by
 *    direct SQL (i.e. drift from a writer that bypassed the API is
 *    detected), and that the guarded path leaves zero drift.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

/** postEntry works on a dedicated client (pool.connect), so fake that. */
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
      command: 'INSERT',
      oid: 0,
      fields: []
    };
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client } as unknown as pg.Pool;
  return { pool, calls };
}

function entry(idempotencyKey: string): LedgerJournalEntry {
  return {
    id: randomUUID(),
    idempotencyKey,
    referenceType: 'wpg13_contract',
    description: 'WP-G13 balance-enforcement contract posting',
    postedAt: new Date().toISOString(),
    postings: [
      { accountCode: 'wpg13:a', direction: 'debit', amountKobo: 1_000 },
      { accountCode: 'wpg13:b', direction: 'credit', amountKobo: 1_000 }
    ]
  };
}

/** Success-path behavior; the balance check verdict is parameterised. */
function behaviorWithBalanceCheck(balanced: boolean, postingCount: number) {
  return (text: string, params: unknown[]): QueryOutcome => {
    if (text.includes('finance.transfer_is_balanced')) {
      return { rows: [{ balanced, posting_count: postingCount }] };
    }
    // P2 perf: account codes are resolved set-based (ONE … WHERE code = ANY
    // query per entry) instead of one SELECT per posting.
    if (text.includes('FROM finance.ledger_accounts WHERE code = ANY')) {
      const codes = (params[0] as string[] | undefined) ?? [];
      return { rows: codes.map((code) => ({ code, id: `acct-${code}` })) };
    }
    return { rows: [] };
  };
}

describe('pg ledger balance enforcement (query spy)', () => {
  it('asserts transfer_is_balanced INSIDE the transaction, after the postings, before COMMIT', async () => {
    const { pool, calls } = fakePool(behaviorWithBalanceCheck(true, 2));
    const repo = new PgLedgerEntryRepository(pool);

    await repo.postEntry(entry('spy-ok-1'));

    const checkIdx = calls.findIndex((call) => call.text.includes('finance.transfer_is_balanced'));
    const lastPostingIdx = calls
      .map((call, index) => ({ call, index }))
      .filter((item) => item.call.text.startsWith('INSERT INTO finance.ledger_entries'))
      .map((item) => item.index)
      .pop()!;
    const commitIdx = calls.findIndex((call) => call.text === 'COMMIT');
    expect(checkIdx).toBeGreaterThan(lastPostingIdx);
    expect(commitIdx).toBeGreaterThan(checkIdx);
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(false);
  });

  it('an unbalanced verdict ROLLBACKs the whole posting (transfer + postings never commit)', async () => {
    const { pool, calls } = fakePool(behaviorWithBalanceCheck(false, 2));
    const repo = new PgLedgerEntryRepository(pool);

    await expect(repo.postEntry(entry('spy-unbalanced'))).rejects.toThrowError(BadRequestException);
    await expect(repo.postEntry(entry('spy-unbalanced-2'))).rejects.toThrowError(/Unbalanced/);
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(true);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false);
  });

  it('a transfer with fewer than two postings fails even when the sums match (0 = 0)', async () => {
    const { pool, calls } = fakePool(behaviorWithBalanceCheck(true, 1));
    const repo = new PgLedgerEntryRepository(pool);

    await expect(repo.postEntry(entry('spy-single-sided'))).rejects.toThrowError(/Unbalanced/);
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(true);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false);
  });

  it('the assertion runs BEFORE the outbox insert, so a rejected posting leaves no event', async () => {
    const { pool, calls } = fakePool(behaviorWithBalanceCheck(false, 2));
    const repo = new PgLedgerEntryRepository(pool);

    await expect(
      repo.postEntry(entry('spy-no-outbox'), undefined, {
        id: 'event-1',
        name: 'finance.ledger.entry_posted',
        payload: {},
        occurredAt: new Date().toISOString()
      })
    ).rejects.toThrowError(BadRequestException);
    const checkIdx = calls.findIndex((call) => call.text.includes('finance.transfer_is_balanced'));
    const outboxIdx = calls.findIndex((call) => call.text.startsWith('INSERT INTO events.outbox'));
    expect(outboxIdx === -1 || outboxIdx > checkIdx).toBe(true);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false);
  });

  it('the reconciliation query lists committed transfers failing the invariant', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const repo = new PgLedgerEntryRepository(pool);

    await repo.findUnbalancedEntries();

    // P2 perf: the drift query is a set-based grouped aggregate equivalent
    // of transfer_is_balanced (debits <> credits) OR the <2-postings
    // minimum (posting_count < 2, including zero-posting transfers) — one
    // pass over ledger_entries instead of a per-row PL/pgSQL call.
    const query = calls.find((call) => call.text.includes('FROM finance.ledger_transfers'));
    expect(query).toBeDefined();
    expect(query!.text).toContain('GROUP BY e.transfer_id');
    expect(query!.text).toContain('s.debits <> s.credits');
    expect(query!.text).toContain('s.posting_count < 2');
    expect(query!.text).toContain('s.transfer_id IS NULL');
  });
});

/**
 * Live contract tests. Skipped unless DATABASE_URL points at a database with
 * the finance schema (001_init.sql) applied (CI db-contract job).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// NOT 'contract-%': pg-repositories.spec.ts deletes LIKE 'contract-%' rows
// across shared tables while suites run in parallel.
const PREFIX = 'wpg13bal-';

async function seedAccounts(): Promise<void> {
  if (!pool) return;
  for (const code of [`${PREFIX}a`, `${PREFIX}b`]) {
    await pool.query(
      `INSERT INTO finance.ledger_accounts (id, code, account_type, currency)
       VALUES ($1, $2, 'asset', 'NGN') ON CONFLICT (code) DO NOTHING`,
      [randomUUID(), code]
    );
  }
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `DELETE FROM finance.ledger_entries WHERE transfer_id IN (
       SELECT id FROM finance.ledger_transfers WHERE idempotency_key LIKE '${PREFIX}%')`
  );
  await pool.query(`DELETE FROM finance.ledger_transfers WHERE idempotency_key LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM finance.ledger_accounts WHERE code LIKE '${PREFIX}%'`);
}

describePg('pg ledger balance enforcement (live)', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('a guarded posting leaves zero drift; a rogue direct-SQL transfer IS detected', async () => {
    if (!pool) return;
    await seedAccounts();
    const repo = new PgLedgerEntryRepository(pool);

    // Guarded path: a balanced posting commits and reconciles clean.
    const posted = await repo.postEntry({
      id: randomUUID(),
      idempotencyKey: `${PREFIX}guarded`,
      referenceType: 'wpg13_contract',
      postedAt: new Date().toISOString(),
      postings: [
        { accountCode: `${PREFIX}a`, direction: 'debit', amountKobo: 5_000 },
        { accountCode: `${PREFIX}b`, direction: 'credit', amountKobo: 5_000 }
      ]
    });
    expect(posted.id).toBeTruthy();
    expect(await repo.findUnbalancedEntries()).toEqual([]);

    // A writer bypassing the API (direct SQL): one debit-only posting. The
    // drift-detection query must find it — this is the pg-level proof that
    // drift can never be silent.
    const rogueId = randomUUID();
    const account = await pool.query(
      `SELECT id FROM finance.ledger_accounts WHERE code = $1`,
      [`${PREFIX}a`]
    );
    await pool.query(
      `INSERT INTO finance.ledger_transfers (id, idempotency_key, reference_type)
       VALUES ($1, $2, 'wpg13_contract')`,
      [rogueId, `${PREFIX}rogue`]
    );
    await pool.query(
      `INSERT INTO finance.ledger_entries (transfer_id, account_id, direction, amount_kobo)
       VALUES ($1, $2, 'debit', 999)`,
      [rogueId, account.rows[0].id]
    );
    const drift = await repo.findUnbalancedEntries();
    expect(drift.map((item) => item.id)).toContain(rogueId);
    // The guarded entry is NOT flagged.
    expect(drift.map((item) => item.id)).not.toContain(posted.id);
  });
});
