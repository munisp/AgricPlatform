import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { PgLedgerEntryRepository } from './ledger.pg-repository.js';

/**
 * P2 perf query-spy tests: postEntry must resolve account codes and insert
 * posting rows SET-BASED (one SELECT … ANY + one INSERT … SELECT per entry,
 * not a SELECT+INSERT per posting), the solvency guard must aggregate all
 * protected accounts in ONE grouped query, and the read fan-out
 * (withPostings) must fetch postings for all matched transfers in one
 * ANY($1) query. Semantics (unknown-code error, balance/solvency rollback)
 * are unchanged.
 */

interface QueryCall {
  text: string;
  params?: unknown[];
}

function entry(twoPostings = true): LedgerJournalEntry {
  const postings = [
    { accountCode: 'platform:cash', direction: 'debit' as const, amountKobo: 5000 },
    ...(twoPostings
      ? [{ accountCode: 'platform:fees', direction: 'credit' as const, amountKobo: 5000 }]
      : [])
  ];
  return {
    id: '11111111-1111-1111-1111-111111111111',
    idempotencyKey: 'key-1',
    referenceType: 'marketplace_order',
    referenceId: 'order-1',
    postedAt: '2026-01-01T00:00:00.000Z',
    postings
  };
}

/**
 * Spy pool whose client answers the fixed posting-pipeline queries by
 * pattern; every call is recorded for assertion.
 */
function spyPool(options?: {
  accountCodes?: string[];
  balances?: Array<{ code: string; debits: number; credits: number }>;
}) {
  const calls: QueryCall[] = [];
  let released = false;
  const knownAccounts = (options?.accountCodes ?? ['platform:cash', 'platform:fees']).map(
    (code, index) => ({ code, id: `acct-${index}` })
  );
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM finance.ledger_accounts WHERE code = ANY')) {
        return { rows: knownAccounts, rowCount: knownAccounts.length };
      }
      if (text.includes('finance.transfer_is_balanced')) {
        return { rows: [{ balanced: true, posting_count: 2 }], rowCount: 1 };
      }
      if (text.includes('GROUP BY a.code')) {
        return { rows: options?.balances ?? [], rowCount: options?.balances?.length ?? 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {
      released = true;
    }
  } as unknown as pg.PoolClient;
  const poolCalls: QueryCall[] = [];
  const pool = {
    connect: async () => client,
    query: async (text: string, params?: unknown[]) => {
      poolCalls.push({ text, params });
      return { rows: [], rowCount: 0 };
    }
  } as unknown as pg.Pool;
  return { pool, calls, poolCalls, isReleased: () => released };
}

describe('PgLedgerEntryRepository.postEntry (P2 batched posting)', () => {
  it('resolves account codes and inserts postings set-based (no per-posting queries)', async () => {
    const { pool, calls, isReleased } = spyPool();
    const repo = new PgLedgerEntryRepository(pool);

    await repo.postEntry(entry());

    const accountSelects = calls.filter(
      (call) =>
        call.text.includes('FROM finance.ledger_accounts') && call.text.includes('SELECT code, id')
    );
    expect(accountSelects).toHaveLength(1);
    expect(accountSelects[0].text).toContain('ANY($1::text[])');
    expect(accountSelects[0].params?.[0]).toEqual(['platform:cash', 'platform:fees']);
    const entryInserts = calls.filter((call) =>
      call.text.includes('INSERT INTO finance.ledger_entries')
    );
    expect(entryInserts).toHaveLength(1);
    expect(entryInserts[0].text).toContain('unnest');
    expect(entryInserts[0].params?.[1]).toEqual(['platform:cash', 'platform:fees']);
    expect(entryInserts[0].params?.[3]).toEqual([5000, 5000]);
    expect(calls[0].text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
    expect(isReleased()).toBe(true);
  });

  it('rejects an unknown account code before any posting insert (rollback)', async () => {
    const { pool, calls } = spyPool({ accountCodes: ['platform:cash'] });
    const repo = new PgLedgerEntryRepository(pool);

    await expect(repo.postEntry(entry())).rejects.toThrow(
      "Unknown ledger account code 'platform:fees'"
    );
    expect(calls.some((call) => call.text.includes('INSERT INTO finance.ledger_entries'))).toBe(
      false
    );
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('runs the solvency guard as ONE grouped aggregate and throws on a negative balance', async () => {
    const { pool, calls } = spyPool({
      balances: [{ code: 'platform:cash', debits: 0, credits: 5000 }]
    });
    const repo = new PgLedgerEntryRepository(pool);

    await expect(repo.postEntry(entry(), ['platform:cash'])).rejects.toThrow(
      "Insufficient funds: posting would take ledger account 'platform:cash' negative (-5000 kobo)"
    );
    const guardQueries = calls.filter((call) => call.text.includes('GROUP BY a.code'));
    expect(guardQueries).toHaveLength(1);
    expect(guardQueries[0].params?.[0]).toEqual(['platform:cash']);
    // The per-account SUM shape is preserved inside the grouped query.
    expect(guardQueries[0].text).toContain("FILTER (WHERE e.direction = 'debit')");
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('passes the solvency guard when the grouped balance is non-negative', async () => {
    const { pool, calls } = spyPool({
      balances: [{ code: 'platform:cash', debits: 9000, credits: 5000 }]
    });
    const repo = new PgLedgerEntryRepository(pool);

    await repo.postEntry(entry(), ['platform:cash']);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });
});

describe('PgLedgerEntryRepository read fan-out (P2 batched withPostings)', () => {
  function readPool(postingRows: Record<string, unknown>[], transferIds: string[] = ['t-1', 't-2']) {
    const calls: QueryCall[] = [];
    const pool = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        if (text.includes('FROM finance.ledger_transfers')) {
          const rows = transferIds.map((id, index) => ({
            id,
            idempotency_key: `k-${index + 1}`,
            reference_type: 'payout',
            reference_id: 'p-1',
            description: null,
            reverses_transfer_id: null,
            posted_at: `2026-01-0${index + 1}T00:00:00.000Z`
          }));
          return { rows, rowCount: rows.length };
        }
        return { rows: postingRows, rowCount: postingRows.length };
      }
    } as unknown as pg.Pool;
    return { pool, calls };
  }

  it('fetches postings for all matched transfers in ONE ANY($1) query, grouped per transfer', async () => {
    const { pool, calls } = readPool([
      { transfer_id: 't-1', account_code: 'platform:cash', direction: 'debit', amount_kobo: 100 },
      { transfer_id: 't-1', account_code: 'platform:fees', direction: 'credit', amount_kobo: 100 },
      { transfer_id: 't-2', account_code: 'platform:cash', direction: 'debit', amount_kobo: 200 },
      { transfer_id: 't-2', account_code: 'platform:fees', direction: 'credit', amount_kobo: 200 }
    ]);
    const repo = new PgLedgerEntryRepository(pool);

    const entries = await repo.find({ referenceType: 'payout', referenceId: 'p-1' });

    const postingQueries = calls.filter((call) =>
      call.text.includes('FROM finance.ledger_entries')
    );
    expect(postingQueries).toHaveLength(1);
    expect(postingQueries[0].text).toContain('e.transfer_id = ANY($1::uuid[])');
    expect(postingQueries[0].params?.[0]).toEqual(['t-1', 't-2']);
    expect(entries).toHaveLength(2);
    expect(entries[0].postings.map((p) => p.amountKobo)).toEqual([100, 100]);
    expect(entries[1].postings.map((p) => p.amountKobo)).toEqual([200, 200]);
  });

  it('issues no postings query when no transfers matched', async () => {
    const { pool, calls } = readPool([], []);
    const repo = new PgLedgerEntryRepository(pool);

    const entries = await repo.find({ referenceType: 'payout' });
    expect(entries).toEqual([]);
    expect(calls.some((call) => call.text.includes('FROM finance.ledger_entries'))).toBe(false);
  });
});

describe('PgLedgerEntryRepository.findUnbalancedEntries (P2 set-based)', () => {
  it('detects imbalance with ONE grouped aggregate (no per-row function call)', async () => {
    const calls: QueryCall[] = [];
    const pool = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return { rows: [], rowCount: 0 };
      }
    } as unknown as pg.Pool;
    const repo = new PgLedgerEntryRepository(pool);

    const drift = await repo.findUnbalancedEntries();

    expect(drift).toEqual([]);
    // One transfer query, no postings query (no rows), and the predicate is
    // the set-based grouped aggregate equivalent of transfer_is_balanced.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toContain('transfer_is_balanced(t.id)');
    expect(calls[0].text).toContain('GROUP BY e.transfer_id');
    expect(calls[0].text).toContain('s.debits <> s.credits');
    expect(calls[0].text).toContain('s.posting_count < 2');
    expect(calls[0].text).toContain('s.transfer_id IS NULL');
  });
});
