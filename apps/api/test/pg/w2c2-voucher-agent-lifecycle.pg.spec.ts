import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import { PgLedgerEntryRepository } from '../../src/database/repositories/ledger.pg-repository.js';
import {
  createPgAgentDeviceRepository,
  createPgAgentReversalRepository,
  createPgAgentVoucherRepository
} from '../../src/database/repositories/agent-banking.pg-repository.js';
import {
  createPgInputVoucherRepository,
  createPgProgrammeFundingRepository,
  createPgRedemptionRepository
} from '../../src/database/repositories/input-vouchers.pg-repository.js';

/**
 * W2-C2 pack (voucher + agent-banking design gaps; migrations 100–104):
 *   V-02  input-voucher refund/reversal (REDEEMED→REFUNDING→REFUNDED)
 *   V-32  partial redemption (per-part rows, UNIQUE (voucher_id, part_seq))
 *   V-33  paid agent-voucher issuance liability + expiry auto-refund
 *   V-08  agent reversal instrument (maker-checker, exact inverse legs)
 *   V-40  agent deregistration close-out + voucher grace window
 *   V-41  agent device binding (hash-at-rest) + remote freeze/revoke
 *
 * Two layers, mirroring the 047/054 pg patterns:
 *  - query-spy tests (always on): prove the exact SQL shapes — per-part
 *    redemption insert, lifecycle column CAS, the settled_kobo refund CTE,
 *    the reversal/device inserts and the daily-limit correction UPDATE.
 *  - live contract tests (describe.skipIf(!DATABASE_URL)): exercised by CI's
 *    db-contract job against a database with migrations through 104 applied.
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
    return { rows: outcome.rows, rowCount: outcome.rowCount ?? outcome.rows.length };
  };
  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client } as unknown as pg.Pool;
  return { pool, calls };
}

const ok = (): QueryOutcome => ({ rows: [], rowCount: 1 });

describe('W2-C2 V-32/V-02 input-voucher lifecycle (query spy)', () => {
  it('redemption rows carry part_seq (per-part anti-double-spend key)', async () => {
    const { pool, calls } = fakePool(() => ok());
    const repo = createPgRedemptionRepository(pool);
    await repo.create({
      id: 'ired-1',
      voucherId: 'iv-1',
      partSeq: 2,
      programmeId: 'prog-1',
      supplierId: 'sup-1',
      invoiceRef: 'INV-9',
      amountKobo: 40_000,
      idempotencyKey: 'input-voucher-redemption:iv-1:part-2',
      ledgerEntryId: 'entry-1',
      createdAt: new Date().toISOString()
    });
    const insert = calls.find((call) => call.text.startsWith('INSERT INTO input_vouchers.redemptions'));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('part_seq');
    expect(insert!.params[9]).toBe(2);
  });

  it('voucher CAS patch maps the lifecycle columns (redeemed/pending/refunded)', async () => {
    const { pool, calls } = fakePool(() => ok());
    const repo = createPgInputVoucherRepository(pool);
    await repo.updateExpected(
      'iv-1',
      { status: 'REFUNDED', refundedAt: new Date().toISOString(), refundedAmountKobo: 200_000, complaintCaseId: 'case-7' },
      { status: 'REFUNDING' }
    );
    const update = calls.find((call) => call.text.startsWith('UPDATE input_vouchers.vouchers'));
    expect(update).toBeTruthy();
    expect(update!.text).toContain('refunded_at');
    expect(update!.text).toContain('refunded_amount_kobo');
    expect(update!.text).toContain('complaint_case_id');
    // claim-first CAS: expected status is a WHERE guard, never a SET value
    expect(update!.text).toMatch(/WHERE id = \$1 AND status = \$\d+/);
  });

  it('refundSettled moves settled→available with a settled_kobo guard, marker-keyed', async () => {
    const { pool, calls } = fakePool(() => ok());
    const repo = createPgProgrammeFundingRepository(pool);
    await repo.refundSettled('prog-1', 200_000, 'input-voucher-funding-refund:iv-1', 'admin-1');
    expect(calls).toHaveLength(1);
    const text = calls[0].text;
    expect(text).toContain("input_vouchers.programme_funding_events");
    expect(text).toContain("'refund'");
    expect(text).toContain('settled_kobo = settled_kobo - $3');
    expect(text).toContain('settled_kobo >= $3'); // fail closed: settled can never go negative
    expect(text).toContain('ON CONFLICT DO NOTHING'); // marker replay is a no-op
    expect(calls[0].params[0]).toBe('input-voucher-funding-refund:iv-1');
  });
});

describe('W2-C2 V-08/V-41 agent reversal + device persistence (query spy)', () => {
  it('reversal insert carries fraud-case linkage + maker-checker fields', async () => {
    const { pool, calls } = fakePool(() => ok());
    const repo = createPgAgentReversalRepository(pool);
    await repo.create({
      id: 'rev-1',
      agentId: 'agent-1',
      transactionId: 'agtx-1',
      amountKobo: 40_000,
      reason: 'fake deposit',
      fraudCaseId: 'fraud-9',
      status: 'PENDING',
      initiatedBy: 'user-agent',
      idempotencyKey: 'rev-key-1',
      createdAt: new Date().toISOString()
    });
    const insert = calls.find((call) => call.text.startsWith('INSERT INTO agent_banking.reversals'));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('fraud_case_id');
    expect(insert!.text).toContain('initiated_by');
    expect(insert!.params).toContain('fraud-9');
  });

  it('device insert persists ONLY the token hash (hash-at-rest)', async () => {
    const { pool, calls } = fakePool(() => ok());
    const repo = createPgAgentDeviceRepository(pool);
    await repo.create({
      id: 'dev-1',
      agentId: 'agent-1',
      deviceTokenHash: 'sha256deadbeef',
      status: 'ACTIVE',
      boundBy: 'user-agent',
      createdAt: new Date().toISOString()
    });
    const insert = calls.find((call) => call.text.startsWith('INSERT INTO agent_banking.devices'));
    expect(insert).toBeTruthy();
    expect(insert!.text).toContain('device_token_hash');
    expect(insert!.params).not.toContain(expect.stringContaining('device-token-'));
  });

  it('reversal daily-limit correction UPDATEs the counter inside the posting transaction', async () => {
    const { pool, calls } = fakePool((text, params) => {
      if (text.includes('posting_count')) {
        return { rows: [{ balanced: true, posting_count: 2 }] }; // assertTransferBalancedTx
      }
      // P2 perf: set-based account-code resolution (ONE … code = ANY query).
      if (text.includes('FROM finance.ledger_accounts WHERE code = ANY')) {
        const codes = (params[0] as string[] | undefined) ?? [];
        return { rows: codes.map((code) => ({ code, id: randomUUID() })) };
      }
      if (text.includes('FROM finance.ledger_accounts')) {
        return { rows: [{ id: randomUUID() }] };
      }
      return ok();
    });
    const repo = new PgLedgerEntryRepository(pool);
    const entry: LedgerJournalEntry = {
      id: randomUUID(),
      idempotencyKey: 'agent-tx-reversal:rev-1',
      referenceType: 'agent_banking_reversal',
      referenceId: 'rev-1',
      description: 'reversal',
      reversesEntryId: 'orig-entry',
      postedAt: new Date().toISOString(),
      postings: [
        { accountCode: 'agent:agent-1:float', direction: 'debit', amountKobo: 40_000 },
        { accountCode: 'member:farmer-1:wallet', direction: 'credit', amountKobo: 40_000 }
      ]
    };
    await repo.postEntry(entry, undefined, undefined, undefined, {
      agentId: 'agent-1',
      businessDate: '2026-09-17',
      amountKobo: 40_000
    });
    const correction = calls.find((call) =>
      call.text.includes('UPDATE agent_banking.agent_daily_limits')
    );
    expect(correction).toBeTruthy();
    expect(correction!.text).toContain('GREATEST(0, used_amount_kobo - $3::bigint)');
    expect(correction!.params).toEqual(['agent-1', '2026-09-17', 40_000]);
    // Committed as one unit with the journal entry.
    expect(calls[0].text).toBe('BEGIN');
    expect(calls[calls.length - 1].text).toBe('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// Live contract layer (CI db-contract job; skipped locally without a database)
// ---------------------------------------------------------------------------

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// The pool is shared by both live describes below, so it must be ended once —
// a per-describe pool.end() kills the sibling describe's seed ("Cannot use a
// pool after calling end on the pool", CI db-contract failure, 2026-09-18).
afterAll(async () => {
  await pool?.end();
});

// NOT 'contract-%': pg-repositories.spec.ts deletes LIKE 'contract-%' rows.
const PREFIX = 'w2c2-';
const AGENT_ID = `${PREFIX}agent`;
const FARMER_ID = `${PREFIX}farmer`;
const SUPPLIER_ID = `${PREFIX}supplier`;
const PROGRAMME_ID = `${PREFIX}prog`;
const BENEFICIARY_ID = `${PREFIX}ben`;
const FLOAT_CODE = `agent:${AGENT_ID}:float`;
const COMMISSION_CODE = `agent:${AGENT_ID}:commission_payable`;

async function seed(): Promise<void> {
  if (!pool) return;
  for (const [id, phone] of [
    [FARMER_ID, '+2348099800002'],
    [SUPPLIER_ID, '+2348099800003'],
    [`${PREFIX}agent-user`, '+2348099800001']
  ] as const) {
    await pool.query(
      `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, phone, `W2-C2 contract ${id}`]
    );
  }
  await pool.query(
    `INSERT INTO agent_banking.agents
       (id, user_id, organisation, status, float_account_code, commission_account_code, daily_limit_kobo, low_float_threshold_kobo)
     VALUES ($1, $2, 'W2-C2 contract coop', 'ACTIVE', $3, $4, 100000000, 100000)
     ON CONFLICT (id) DO NOTHING`,
    [AGENT_ID, `${PREFIX}agent-user`, FLOAT_CODE, COMMISSION_CODE]
  );
  await pool.query(
    `INSERT INTO input_vouchers.programmes
       (id, name, sponsor, status, per_farmer_cap_kobo, budget_kobo, liability_account_code, created_by)
     VALUES ($1, 'W2-C2 contract programme', 'Contract sponsor (test)', 'ACTIVE', 100000000, 100000000, $2, 'w2c2-test')
     ON CONFLICT (id) DO NOTHING`,
    [PROGRAMME_ID, `programme:${PROGRAMME_ID}:liability`]
  );
  await pool.query(
    `INSERT INTO input_vouchers.beneficiaries
       (id, programme_id, farmer_id, nin_hash, nin_mask, verification_basis, verified_at)
     VALUES ($1, $2, $3, 'hash', '****0000', 'stub', now())
     ON CONFLICT (id) DO NOTHING`,
    [BENEFICIARY_ID, PROGRAMME_ID, FARMER_ID]
  );
}

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM agent_banking.devices WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM agent_banking.reversals WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM agent_banking.agent_daily_limits WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM agent_banking.transactions WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM agent_banking.vouchers WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM input_vouchers.redemptions WHERE programme_id = $1`, [PROGRAMME_ID]);
  await pool.query(`DELETE FROM input_vouchers.vouchers WHERE programme_id = $1`, [PROGRAMME_ID]);
  await pool.query(`DELETE FROM input_vouchers.programme_funding_events WHERE programme_id = $1`, [PROGRAMME_ID]);
  await pool.query(`DELETE FROM input_vouchers.programme_funding WHERE programme_id = $1`, [PROGRAMME_ID]);
  await pool.query(`DELETE FROM input_vouchers.beneficiaries WHERE programme_id = $1`, [PROGRAMME_ID]);
  await pool.query(`DELETE FROM input_vouchers.programmes WHERE id = $1`, [PROGRAMME_ID]);
  await pool.query(
    `DELETE FROM finance.ledger_entries WHERE transfer_id IN (
       SELECT id FROM finance.ledger_transfers WHERE idempotency_key LIKE '${PREFIX}%')`
  );
  await pool.query(`DELETE FROM finance.ledger_transfers WHERE idempotency_key LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM finance.ledger_accounts WHERE code LIKE '${PREFIX}%' OR code LIKE 'agent:${PREFIX}%' OR code LIKE 'member:${PREFIX}%' OR code LIKE 'programme:${PREFIX}%'`);
  await pool.query(`DELETE FROM agent_banking.agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM identity.user_roles WHERE user_id LIKE '${PREFIX}%'`);
  await pool.query(`DELETE FROM identity.users WHERE id LIKE '${PREFIX}%'`);
}

describe.skipIf(!process.env.DATABASE_URL)('W2-C2 voucher lifecycle (live)', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('V-32: two partials sum ≤ face value; overshoot rejected; concurrent race is single-winner', async () => {
    const vouchers = createPgInputVoucherRepository(pool!);
    const redemptions = createPgRedemptionRepository(pool!);
    await vouchers.create({
      id: `${PREFIX}iv-1`,
      programmeId: PROGRAMME_ID,
      beneficiaryId: BENEFICIARY_ID,
      farmerId: FARMER_ID,
      amountKobo: 100_000,
      status: 'ISSUED',
      idempotencyKey: `${PREFIX}alloc-1`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString()
    });
    // Part 1 claims (ISSUED→REDEEMING) then finalizes to PARTIALLY_REDEEMED.
    await vouchers.updateExpected(`${PREFIX}iv-1`, { status: 'REDEEMING', pendingAmountKobo: 60_000 }, { status: 'ISSUED' });
    await redemptions.create({
      id: `${PREFIX}ired-1`,
      voucherId: `${PREFIX}iv-1`,
      partSeq: 1,
      programmeId: PROGRAMME_ID,
      supplierId: SUPPLIER_ID,
      invoiceRef: 'INV-1',
      amountKobo: 60_000,
      idempotencyKey: `input-voucher-redemption:${PREFIX}iv-1`,
      ledgerEntryId: 'entry-1',
      createdAt: new Date().toISOString()
    });
    const partial = await vouchers.updateExpected(
      `${PREFIX}iv-1`,
      { status: 'PARTIALLY_REDEEMED', redeemedAmountKobo: 60_000, pendingAmountKobo: undefined },
      { status: 'REDEEMING' }
    );
    expect(partial.status).toBe('PARTIALLY_REDEEMED');
    expect(partial.redeemedAmountKobo).toBe(60_000);
    // Part 2: the remaining 40k — the pair sums to the face value.
    await vouchers.updateExpected(`${PREFIX}iv-1`, { status: 'REDEEMING', pendingAmountKobo: 40_000 }, { status: 'PARTIALLY_REDEEMED' });
    await redemptions.create({
      id: `${PREFIX}ired-2`,
      voucherId: `${PREFIX}iv-1`,
      partSeq: 2,
      programmeId: PROGRAMME_ID,
      supplierId: SUPPLIER_ID,
      invoiceRef: 'INV-2',
      amountKobo: 40_000,
      idempotencyKey: `input-voucher-redemption:${PREFIX}iv-1:part-2`,
      ledgerEntryId: 'entry-2',
      createdAt: new Date().toISOString()
    });
    // UNIQUE (voucher_id, part_seq): a duplicate part 2 is rejected.
    await expect(
      redemptions.create({
        id: `${PREFIX}ired-2b`,
        voucherId: `${PREFIX}iv-1`,
        partSeq: 2,
        programmeId: PROGRAMME_ID,
        supplierId: SUPPLIER_ID,
        invoiceRef: 'INV-2',
        amountKobo: 40_000,
        idempotencyKey: `input-voucher-redemption:${PREFIX}iv-1:part-2b`,
        ledgerEntryId: 'entry-2b',
        createdAt: new Date().toISOString()
      })
    ).rejects.toBeTruthy();
    const redeemed = await vouchers.updateExpected(
      `${PREFIX}iv-1`,
      { status: 'REDEEMED', redeemedAmountKobo: 100_000, pendingAmountKobo: undefined },
      { status: 'REDEEMING' }
    );
    expect(redeemed.status).toBe('REDEEMED');
    // Overshoot rejected at the storage layer: redeemed_amount_kobo <= amount_kobo CHECK.
    await expect(
      pool!.query(`UPDATE input_vouchers.vouchers SET redeemed_amount_kobo = 100001 WHERE id = $1`, [`${PREFIX}iv-1`])
    ).rejects.toBeTruthy();
    // Concurrent race on the claim CAS is single-winner.
    await vouchers.create({
      id: `${PREFIX}iv-2`,
      programmeId: PROGRAMME_ID,
      beneficiaryId: BENEFICIARY_ID,
      farmerId: FARMER_ID,
      amountKobo: 50_000,
      status: 'ISSUED',
      idempotencyKey: `${PREFIX}alloc-2`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString()
    });
    const race = await Promise.allSettled([
      vouchers.updateExpected(`${PREFIX}iv-2`, { status: 'REDEEMING', pendingAmountKobo: 30_000 }, { status: 'ISSUED' }),
      vouchers.updateExpected(`${PREFIX}iv-2`, { status: 'REDEEMING', pendingAmountKobo: 30_000 }, { status: 'ISSUED' })
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('V-02: REDEEMED→REFUNDED CAS is single-winner and the refund markers persist', async () => {
    const vouchers = createPgInputVoucherRepository(pool!);
    await vouchers.create({
      id: `${PREFIX}iv-3`,
      programmeId: PROGRAMME_ID,
      beneficiaryId: BENEFICIARY_ID,
      farmerId: FARMER_ID,
      amountKobo: 80_000,
      status: 'REDEEMED',
      redeemedAmountKobo: 80_000,
      idempotencyKey: `${PREFIX}alloc-3`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString()
    });
    const [first, second] = await Promise.allSettled([
      vouchers.updateExpected(`${PREFIX}iv-3`, { status: 'REFUNDING', complaintCaseId: 'case-1' }, { status: 'REDEEMED' }),
      vouchers.updateExpected(`${PREFIX}iv-3`, { status: 'REFUNDING', complaintCaseId: 'case-1' }, { status: 'REDEEMED' })
    ]);
    expect([first, second].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refunded = await vouchers.updateExpected(
      `${PREFIX}iv-3`,
      { status: 'REFUNDED', refundedAt: new Date().toISOString(), refundedAmountKobo: 80_000 },
      { status: 'REFUNDING' }
    );
    expect(refunded.status).toBe('REFUNDED');
    expect(refunded.complaintCaseId).toBe('case-1');
    // Idempotent funding refund marker: a replay inserts nothing, moves nothing.
    const funding = createPgProgrammeFundingRepository(pool!);
    await pool!.query(
      `INSERT INTO input_vouchers.programme_funding (programme_id, funded_kobo, reserved_kobo, settled_kobo)
       VALUES ($1, 80000, 0, 80000) ON CONFLICT (programme_id) DO NOTHING`,
      [PROGRAMME_ID]
    );
    await funding.refundSettled(PROGRAMME_ID, 80_000, `input-voucher-funding-refund:${PREFIX}iv-3`, 'admin');
    await funding.refundSettled(PROGRAMME_ID, 80_000, `input-voucher-funding-refund:${PREFIX}iv-3`, 'admin');
    const row = await pool!.query(
      `SELECT settled_kobo FROM input_vouchers.programme_funding WHERE programme_id = $1`,
      [PROGRAMME_ID]
    );
    expect(Number(row.rows[0].settled_kobo)).toBe(0); // refunded exactly once
  });
});

describe.skipIf(!process.env.DATABASE_URL)('W2-C2 agent banking (live)', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('V-33: an expired paid voucher carries a PAYABLE refund visible in the settlement index', async () => {
    const vouchers = createPgAgentVoucherRepository(pool!);
    await vouchers.create({
      id: `${PREFIX}av-1`,
      agentId: AGENT_ID,
      farmerId: FARMER_ID,
      amountKobo: 70_000,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      nonce: 'n1',
      signature: 'sig',
      status: 'ISSUED',
      idempotencyKey: `${PREFIX}av-issue-1`,
      issuanceLedgerEntryId: 'entry-iss-1',
      refundStatus: 'NONE',
      createdAt: new Date().toISOString()
    });
    const expired = await vouchers.updateExpected(`${PREFIX}av-1`, { status: 'EXPIRED' }, { status: 'ISSUED' });
    const payable = await vouchers.updateExpected(
      expired.id,
      { refundStatus: 'PAYABLE', refundLedgerEntryId: 'entry-ref-1' },
      { status: 'EXPIRED' }
    );
    expect(payable.refundStatus).toBe('PAYABLE');
    // The settlement queue index finds it.
    const queued = await pool!.query(
      `SELECT id FROM agent_banking.vouchers WHERE agent_id = $1 AND refund_status = 'PAYABLE'`,
      [AGENT_ID]
    );
    expect(queued.rows.map((row) => row.id)).toContain(`${PREFIX}av-1`);
  });

  it('V-08: one live reversal per transaction; REJECTED releases the slot', async () => {
    await pool!.query(
      `INSERT INTO agent_banking.transactions
         (id, agent_id, farmer_id, type, amount_kobo, commission_kobo, idempotency_key, ledger_entry_id)
       VALUES ($1, $2, $3, 'cash_in', 40000, 400, $4, 'entry-tx-1')`,
      [`${PREFIX}tx-1`, AGENT_ID, FARMER_ID, `${PREFIX}tx-key-1`]
    );
    const repo = createPgAgentReversalRepository(pool!);
    const base = {
      agentId: AGENT_ID,
      transactionId: `${PREFIX}tx-1`,
      amountKobo: 40_000,
      reason: 'fake deposit',
      status: 'PENDING' as const,
      initiatedBy: 'user-a',
      createdAt: new Date().toISOString()
    };
    await repo.create({ ...base, id: `${PREFIX}rev-1`, idempotencyKey: `${PREFIX}rev-key-1` });
    // A second live reversal for the same transaction violates the partial index.
    await expect(
      repo.create({ ...base, id: `${PREFIX}rev-2`, idempotencyKey: `${PREFIX}rev-key-2` })
    ).rejects.toBeTruthy();
    const rejected = await repo.updateExpected(`${PREFIX}rev-1`, { status: 'REJECTED', decidedBy: 'user-b', decidedAt: new Date().toISOString() }, { status: 'PENDING' });
    expect(rejected.status).toBe('REJECTED');
    // Slot released: a corrected reversal can be initiated.
    await repo.create({ ...base, id: `${PREFIX}rev-3`, idempotencyKey: `${PREFIX}rev-key-3` });
  });

  it('V-40: deregistration columns persist; grace window row state round-trips', async () => {
    await pool!.query(
      `UPDATE agent_banking.agents
          SET status = 'DEREGISTERED', deregistered_at = now(),
              voucher_grace_until = now() + interval '30 days',
              deregistration_reason = 'retired'
        WHERE id = $1`,
      [AGENT_ID]
    );
    const row = await pool!.query(`SELECT status, voucher_grace_until FROM agent_banking.agents WHERE id = $1`, [AGENT_ID]);
    expect(row.rows[0].status).toBe('DEREGISTERED');
    expect(row.rows[0].voucher_grace_until).toBeTruthy();
    await pool!.query(`UPDATE agent_banking.agents SET status = 'ACTIVE' WHERE id = $1`, [AGENT_ID]);
  });

  it('V-41: one binding per (agent, device hash); revoke CAS is single-winner', async () => {
    const repo = createPgAgentDeviceRepository(pool!);
    const base = {
      agentId: AGENT_ID,
      deviceTokenHash: 'hash-of-token-1',
      status: 'ACTIVE' as const,
      boundBy: 'user-a',
      createdAt: new Date().toISOString()
    };
    await repo.create({ ...base, id: `${PREFIX}dev-1` });
    await expect(repo.create({ ...base, id: `${PREFIX}dev-2` })).rejects.toBeTruthy();
    const [first, second] = await Promise.allSettled([
      repo.updateExpected(`${PREFIX}dev-1`, { status: 'REVOKED', revokedBy: 'user-b', revokedAt: new Date().toISOString() }, { status: 'ACTIVE' }),
      repo.updateExpected(`${PREFIX}dev-1`, { status: 'REVOKED', revokedBy: 'user-b', revokedAt: new Date().toISOString() }, { status: 'ACTIVE' })
    ]);
    expect([first, second].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
});
