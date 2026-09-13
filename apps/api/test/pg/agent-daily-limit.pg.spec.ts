import { afterEach, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import {
  createPgLedgerEntryRepository,
  PgLedgerEntryRepository
} from '../../src/database/repositories/ledger.pg-repository.js';

/**
 * Agent daily cash-limit reservation (Stage 27 WP-G2, V2 funds-atomicity
 * audit A1-7; migration 054).
 *
 * Two layers, mirroring the 047/048 pg patterns:
 *  - `pg agent daily limit reservation (query spy)`: always-on tests over a
 *    fake pool proving the reservation is ONE atomic conditional upsert
 *    (INSERT … ON CONFLICT … DO UPDATE … WHERE … RETURNING) executed inside
 *    the posting transaction, that a breached cap rejects with the standard
 *    limit-exceeded error and rolls back, and that a posting failure after
 *    the reservation rolls the reservation back with it.
 *  - `pg agent daily limit reservation (live)`: contract tests in the
 *    standard describe.skipIf(!DATABASE_URL) style, exercised by CI's
 *    db-contract job against a database with migrations through 054
 *    applied. Concurrent postings sharing the daily cap must admit exactly
 *    floor(cap/amount) and no more.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

/** postEntry works on a dedicated client (pool.connect), so fake that. */
function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
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
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, calls };
}

function entry(
  idempotencyKey: string,
  amountKobo = 200_000,
  debitCode = 'agent:agent-1:float',
  creditCode = 'member:farmer-1:wallet'
): LedgerJournalEntry {
  return {
    id: randomUUID(),
    idempotencyKey,
    referenceType: 'agent_banking_cash_out',
    referenceId: `tx-${idempotencyKey}`,
    description: 'WP-G2 contract posting',
    postedAt: new Date().toISOString(),
    postings: [
      { accountCode: debitCode, direction: 'debit', amountKobo },
      { accountCode: creditCode, direction: 'credit', amountKobo }
    ]
  };
}

const RESERVATION = {
  agentId: 'agent-1',
  businessDate: '2026-03-01',
  amountKobo: 200_000,
  limitKobo: 600_000
};

/** Success-path behavior: every statement returns a benign result. */
const successBehavior = (text: string): QueryOutcome => {
  if (text.startsWith('INSERT INTO agent_banking.agent_daily_limits')) {
    return { rows: [{ used_amount_kobo: RESERVATION.amountKobo }] };
  }
  if (text.startsWith('SELECT id FROM finance.ledger_accounts')) {
    return { rows: [{ id: `acct-${text.length}` }] };
  }
  if (text.includes('finance.transfer_is_balanced')) {
    // WP-G13 balanced-journal invariant: benign balanced verdict for the spy.
    return { rows: [{ balanced: true, posting_count: 2 }] };
  }
  if (text.includes('FROM finance.ledger_entries')) {
    return { rows: [{ debits: 0, credits: 0 }] };
  }
  return { rows: [] };
};

describe('pg agent daily limit reservation (query spy)', () => {
  it('reserves with a single atomic conditional upsert INSIDE the posting transaction', async () => {
    const { pool, calls } = fakePool(successBehavior);
    const repo = new PgLedgerEntryRepository(pool);

    await repo.postEntry(entry('spy-1'), undefined, undefined, RESERVATION);

    const upsert = calls.find((call) => call.text.startsWith('INSERT INTO agent_banking.agent_daily_limits'));
    expect(upsert).toBeDefined();
    // One atomic statement: no separate SELECT-sum / UPDATE pair.
    expect(
      calls.filter((call) => call.text.includes('agent_banking.agent_daily_limits'))
    ).toHaveLength(1);
    expect(upsert!.text).toContain('ON CONFLICT (agent_id, business_date) DO UPDATE');
    expect(upsert!.text).toContain('WHERE agent_daily_limits.used_amount_kobo + EXCLUDED.used_amount_kobo <=');
    expect(upsert!.text).toContain('RETURNING used_amount_kobo');
    expect(upsert!.params).toEqual(['agent-1', '2026-03-01', 200_000, 600_000]);
    // Between BEGIN and COMMIT — counter and money commit together.
    const beginIdx = calls.findIndex((call) => call.text === 'BEGIN');
    const commitIdx = calls.findIndex((call) => call.text === 'COMMIT');
    const upsertIdx = calls.indexOf(upsert!);
    const transferIdx = calls.findIndex((call) =>
      call.text.startsWith('INSERT INTO finance.ledger_transfers')
    );
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThan(beginIdx);
    expect(transferIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(upsertIdx);
    expect(commitIdx).toBeGreaterThan(transferIdx);
  });

  it('rejects with the standard limit-exceeded error and rolls back when the upsert returns no row', async () => {
    const { pool, calls } = fakePool((text) =>
      text.startsWith('INSERT INTO agent_banking.agent_daily_limits')
        ? { rows: [] } // cap would be breached: conditional upsert matched nothing
        : successBehavior(text)
    );
    const repo = new PgLedgerEntryRepository(pool);

    await expect(repo.postEntry(entry('spy-2'), undefined, undefined, RESERVATION)).rejects.toThrowError(
      BadRequestException
    );
    await expect(repo.postEntry(entry('spy-2b'), undefined, undefined, RESERVATION)).rejects.toThrowError(
      /Agent daily limit exceeded/
    );
    // Nothing posted, transaction rolled back.
    expect(calls.some((call) => call.text === 'ROLLBACK')).toBe(true);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false);
    expect(calls.some((call) => call.text.startsWith('INSERT INTO finance.ledger_transfers'))).toBe(false);
  });

  it('rolls the reservation back when the money posting fails after it', async () => {
    const uniqueViolation = (): Error & { code: string } =>
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const { pool, calls } = fakePool((text) =>
      text.startsWith('INSERT INTO finance.ledger_transfers')
        ? uniqueViolation()
        : successBehavior(text)
    );
    const repo = new PgLedgerEntryRepository(pool);

    await expect(repo.postEntry(entry('spy-3'), undefined, undefined, RESERVATION)).rejects.toThrowError(
      ConflictException
    );
    const upsertIdx = calls.findIndex((call) =>
      call.text.startsWith('INSERT INTO agent_banking.agent_daily_limits')
    );
    const rollbackIdx = calls.findIndex((call) => call.text === 'ROLLBACK');
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(upsertIdx);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(false);
  });

  it('posts without touching the counter when no reservation is requested', async () => {
    const { pool, calls } = fakePool(successBehavior);
    const repo = new PgLedgerEntryRepository(pool);

    await repo.postEntry(entry('spy-4'));

    expect(calls.some((call) => call.text.includes('agent_banking.agent_daily_limits'))).toBe(false);
    expect(calls.some((call) => call.text === 'COMMIT')).toBe(true);
  });
});

/**
 * Live contract tests. Skipped unless DATABASE_URL points at a database with
 * migrations through 054 applied (see test/pg/pg-repositories.spec.ts header
 * for the docker compose invocation; CI's db-contract job runs them).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// NOT 'contract-%': pg-repositories.spec.ts deletes LIKE 'contract-%' rows
// across shared tables while suites run in parallel.
const PREFIX = 'dailylimit-';
const AGENT_ID = `${PREFIX}agent`;
const FARMER_ID = `${PREFIX}farmer`;
const FLOAT_CODE = `agent:${AGENT_ID}:float`;
const WALLET_CODE = `member:${FARMER_ID}:wallet`;

async function seed(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [FARMER_ID, '+2348099900002', 'Daily limit contract farmer']
  );
  await pool.query(
    `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [`${PREFIX}agent-user`, '+2348099900001', 'Daily limit contract agent']
  );
  await pool.query(
    `INSERT INTO agent_banking.agents
       (id, user_id, organisation, status, float_account_code, commission_account_code, daily_limit_kobo, low_float_threshold_kobo)
     VALUES ($1, $2, 'WP-G2 contract coop', 'ACTIVE', $3, $4, 600000, 100000)
     ON CONFLICT (id) DO NOTHING`,
    [AGENT_ID, `${PREFIX}agent-user`, FLOAT_CODE, `agent:${AGENT_ID}:commission_payable`]
  );
  for (const [id, code] of [
    [randomUUID(), FLOAT_CODE],
    [randomUUID(), WALLET_CODE]
  ]) {
    await pool.query(
      `INSERT INTO finance.ledger_accounts (id, code, account_type, currency)
       VALUES ($1, $2, 'asset', 'NGN') ON CONFLICT (code) DO NOTHING`,
      [id, code]
    );
  }
}

async function usedAmount(businessDate: string): Promise<number> {
  if (!pool) return -1;
  const result = await pool.query(
    `SELECT used_amount_kobo FROM agent_banking.agent_daily_limits
      WHERE agent_id = $1 AND business_date = $2`,
    [AGENT_ID, businessDate]
  );
  return result.rows[0] ? Number(result.rows[0].used_amount_kobo) : 0;
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM agent_banking.agent_daily_limits WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(
    `DELETE FROM finance.ledger_entries WHERE transfer_id IN (
       SELECT id FROM finance.ledger_transfers WHERE idempotency_key LIKE '${PREFIX}%')`
  );
  await pool.query(`DELETE FROM finance.ledger_transfers WHERE idempotency_key LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM finance.ledger_accounts WHERE code IN ($1, $2)`, [FLOAT_CODE, WALLET_CODE]);
  await pool.query(`DELETE FROM agent_banking.agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM identity.user_roles WHERE user_id LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM identity.users WHERE id LIKE '${PREFIX}%'`);
}

describePg('pg agent daily limit reservation (live)', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('admits exactly floor(cap/amount) of N concurrent postings — the cap is never exceeded', async () => {
    if (!pool) return;
    await seed();
    const repo = createPgLedgerEntryRepository(pool);
    const businessDate = new Date().toISOString().slice(0, 10);
    const reservation = { agentId: AGENT_ID, businessDate, amountKobo: 200_000, limitKobo: 600_000 };

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        repo.postEntry(entry(`${PREFIX}race-${i}`, 200_000, FLOAT_CODE, WALLET_CODE), undefined, undefined, reservation)
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
    }
    // The committed counter equals exactly the cap — never above it.
    expect(await usedAmount(businessDate)).toBe(600_000);
  });

  it('a failed posting does not consume the counter (same-transaction rollback)', async () => {
    if (!pool) return;
    await seed();
    const repo = createPgLedgerEntryRepository(pool);
    const businessDate = new Date().toISOString().slice(0, 10);
    const reservation = { agentId: AGENT_ID, businessDate, amountKobo: 200_000, limitKobo: 600_000 };

    // Posting references an UNKNOWN account: the reservation is taken, the
    // account resolution then fails, and the rollback must release it.
    const doomed = entry(`${PREFIX}doomed`, 200_000, `${PREFIX}no-such-account`, WALLET_CODE);
    await expect(repo.postEntry(doomed, undefined, undefined, reservation)).rejects.toThrowError(
      BadRequestException
    );
    expect(await usedAmount(businessDate)).toBe(0);

    // The full cap is still available: three 200_000 postings land, a 4th is rejected.
    for (let i = 0; i < 3; i += 1) {
      await repo.postEntry(entry(`${PREFIX}ok-${i}`, 200_000, FLOAT_CODE, WALLET_CODE), undefined, undefined, reservation);
    }
    await expect(
      repo.postEntry(entry(`${PREFIX}over`, 200_000, FLOAT_CODE, WALLET_CODE), undefined, undefined, reservation)
    ).rejects.toThrowError(BadRequestException);
    expect(await usedAmount(businessDate)).toBe(600_000);
  });

  it('a new business date starts a fresh counter', async () => {
    if (!pool) return;
    await seed();
    const repo = createPgLedgerEntryRepository(pool);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    for (let i = 0; i < 3; i += 1) {
      await repo.postEntry(
        entry(`${PREFIX}day1-${i}`, 200_000, FLOAT_CODE, WALLET_CODE),
        undefined,
        undefined,
        { agentId: AGENT_ID, businessDate: today, amountKobo: 200_000, limitKobo: 600_000 }
      );
    }
    await expect(
      repo.postEntry(
        entry(`${PREFIX}day1-over`, 200_000, FLOAT_CODE, WALLET_CODE),
        undefined,
        undefined,
        { agentId: AGENT_ID, businessDate: today, amountKobo: 200_000, limitKobo: 600_000 }
      )
    ).rejects.toThrowError(BadRequestException);

    // Next business date: full cap available again.
    for (let i = 0; i < 3; i += 1) {
      await repo.postEntry(
        entry(`${PREFIX}day2-${i}`, 200_000, FLOAT_CODE, WALLET_CODE),
        undefined,
        undefined,
        { agentId: AGENT_ID, businessDate: tomorrow, amountKobo: 200_000, limitKobo: 600_000 }
      );
    }
    expect(await usedAmount(today)).toBe(600_000);
    expect(await usedAmount(tomorrow)).toBe(600_000);
  });
});
