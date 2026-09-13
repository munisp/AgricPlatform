import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgEscalationCaseRepository } from '../../src/database/repositories/escalation-console.pg-repository.js';
import type { EscalationCaseRecord } from '../../src/database/repositories/escalation-console.repository.js';

/**
 * Agronomist SLA console pg contract (Stage 27 innovation #19, migration
 * 078_agronomist_console.sql).
 *
 * Two layers, mirroring the escrow-payout-claim pg patterns:
 *  - `pg agronomist console (query spy)`: always-on tests over a fake pool
 *    proving the claim CAS compiles to ONE guarded UPDATE whose
 *    precondition pins status='queued' (exactly-one-winner claim lease),
 *    and that the delivered answer write flips status → answered in the
 *    SAME statement that sets delivery_status='delivered' (the DB CHECK
 *    makes any other path to 'answered' a constraint violation).
 *  - `pg agronomist console (live)`: contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style, exercised by CI's db-contract
 *    job against a database with migrations applied. Two concurrent claims
 *    produce EXACTLY ONE winner, the status CHECK rejects out-of-enum
 *    transitions, and the honesty CHECK rejects an 'answered' row whose
 *    channel never confirmed delivery.
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
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

function caseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: 'ecase-pg-1',
    session_id: 'vsession-pg-1',
    agent_case_id: 'vcase-pg-1',
    user_id: null,
    phone: '+2348011111111',
    channel: 'sms',
    cohort: null,
    topic: 'maize',
    locale: 'en',
    priority: 'normal',
    status: 'queued',
    sla_due_at: now,
    sla_breached_at: null,
    assigned_to: null,
    assigned_at: null,
    answer_text: null,
    answered_at: null,
    delivery_status: 'pending',
    delivery_attempts: 0,
    delivery_note: null,
    delivered_at: null,
    quality_score: null,
    quality_scored_by: null,
    quality_scored_at: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

describe('pg agronomist console (query spy)', () => {
  it('claim is ONE guarded UPDATE pinning status=queued (CAS claim lease)', async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [caseRow({ status: 'assigned', assigned_to: 'agronomist-a' })]
    }));
    const repo = new PgEscalationCaseRepository(pool);
    const result = await repo.claim('ecase-pg-1', 'agronomist-a', new Date().toISOString());
    expect(result.won).toBe(true);
    expect(result.record.assignedTo).toBe('agronomist-a');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('UPDATE voice.escalation_cases');
    expect(calls[0].text).toContain("WHERE id = $1 AND status = 'queued'");
    expect(calls[0].text).toContain('RETURNING');
  });

  it('a lost claim re-reads the honest winner for the 409 response', async () => {
    let phase: 'claim' | 'reread' = 'claim';
    const { pool, calls } = fakePool(() => {
      if (phase === 'claim') {
        phase = 'reread';
        return { rows: [], rowCount: 0 };
      }
      return { rows: [caseRow({ status: 'assigned', assigned_to: 'agronomist-a' })] };
    });
    const repo = new PgEscalationCaseRepository(pool);
    const result = await repo.claim('ecase-pg-1', 'agronomist-b', new Date().toISOString());
    expect(result.won).toBe(false);
    expect(result.record.status).toBe('assigned');
    expect(result.record.assignedTo).toBe('agronomist-a');
    expect(calls).toHaveLength(2);
  });

  it('confirmed delivery flips status → answered in the SAME guarded write', async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [
        caseRow({
          status: 'answered',
          answer_text: 'Scout weekly.',
          delivery_status: 'delivered',
          delivery_attempts: 1,
          answered_at: new Date().toISOString()
        })
      ]
    }));
    const repo = new PgEscalationCaseRepository(pool);
    const updated = await repo.recordAnswerDelivery('ecase-pg-1', {
      answerText: 'Scout weekly.',
      delivery: 'delivered',
      at: new Date().toISOString()
    });
    expect(updated.status).toBe('answered');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("status = 'answered'");
    expect(calls[0].text).toContain("WHERE id = $1 AND status = 'assigned'");
  });

  it('failed delivery NEVER touches status — answer recorded, case stays assigned', async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [caseRow({ status: 'assigned', delivery_status: 'failed', delivery_attempts: 1 })]
    }));
    const repo = new PgEscalationCaseRepository(pool);
    await repo.recordAnswerDelivery('ecase-pg-1', {
      answerText: 'Scout weekly.',
      delivery: 'failed',
      deliveryNote: 'termii/stub: simulated',
      at: new Date().toISOString()
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toContain("status = 'answered'");
    expect(calls[0].text).toContain("status = 'assigned'");
  });
});

// -- Live contract layer (CI db-contract job) --------------------------------

const describePg = describe.skipIf(!process.env.DATABASE_URL);
const livePool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATION_027 = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '027_voice.sql'
);
const MIGRATION_078 = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '078_agronomist_console.sql'
);

const SESSION_ID = 'vsession-console-pg-test';
const CASE_ID = 'ecase-console-pg-test';

function liveCase(overrides: Partial<EscalationCaseRecord> = {}): EscalationCaseRecord {
  const now = new Date().toISOString();
  return {
    id: CASE_ID,
    sessionId: SESSION_ID,
    agentCaseId: 'vcase-console-pg-test',
    phone: '+2348011111111',
    channel: 'sms',
    cohort: 'pg-contract',
    topic: 'maize',
    locale: 'en',
    priority: 'normal',
    status: 'queued',
    slaDueAt: new Date(Date.now() + 3_600_000).toISOString(),
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describePg('pg agronomist console (live, migration 078)', () => {
  beforeAll(async () => {
    // Idempotent: both migrations apply twice without error.
    for (const path of [MIGRATION_027, MIGRATION_078]) {
      const sql = readFileSync(path, 'utf8');
      await livePool!.query(sql);
      await livePool!.query(sql);
    }
    await livePool!.query(
      "INSERT INTO voice.voice_sessions (id, channel, state, phone, locale) " +
        "VALUES ($1, 'ussd', 'escalated', '+2348011111111', 'en') ON CONFLICT (id) DO NOTHING",
      [SESSION_ID]
    );
  });

  afterAll(async () => {
    if (livePool) {
      await livePool.query('DELETE FROM voice.escalation_cases WHERE session_id = $1', [SESSION_ID]);
      await livePool.query('DELETE FROM voice.voice_sessions WHERE id = $1', [SESSION_ID]);
      await livePool.end();
    }
  });

  it('two concurrent claims produce EXACTLY ONE winner', async () => {
    const repo = new PgEscalationCaseRepository(livePool!);
    await repo.create(liveCase());
    const [a, b] = await Promise.all([
      repo.claim(CASE_ID, 'agronomist-a', new Date().toISOString()),
      repo.claim(CASE_ID, 'agronomist-b', new Date().toISOString())
    ]);
    expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
    const winner = a.won ? a : b;
    const loser = a.won ? b : a;
    expect(loser.record.assignedTo).toBe(winner.record.assignedTo);
    const stored = await repo.getById(CASE_ID);
    expect(stored.status).toBe('assigned');
    expect(stored.assignedTo).toBe(winner.record.assignedTo);
  });

  it('the status CHECK rejects out-of-enum transitions', async () => {
    await expect(
      livePool!.query(
        "UPDATE voice.escalation_cases SET status = 'lapsed' WHERE id = $1",
        [CASE_ID]
      )
    ).rejects.toThrow(/escalation_cases_status_check|violates check constraint/i);
  });

  it('the honesty CHECK rejects answered-without-confirmed-delivery', async () => {
    await expect(
      livePool!.query(
        "UPDATE voice.escalation_cases SET status = 'answered' WHERE id = $1",
        [CASE_ID]
      )
    ).rejects.toThrow(/escalation_cases_answered_requires_delivery|violates check constraint/i);
    // …and the honest path (assigned + delivered answer in one write) works.
    const repo = new PgEscalationCaseRepository(livePool!);
    const answered = await repo.recordAnswerDelivery(CASE_ID, {
      answerText: 'Scout weekly.',
      delivery: 'delivered',
      at: new Date().toISOString()
    });
    expect(answered.status).toBe('answered');
    expect(answered.deliveryStatus).toBe('delivered');
  });
});
