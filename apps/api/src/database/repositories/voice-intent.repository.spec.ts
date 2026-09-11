import { describe, expect, it } from 'vitest';
import {
  createInMemoryVoiceIntentSessionRepository,
  type VoiceIntentSessionRecord
} from './voice-intent.repository.js';
import { PgVoiceIntentSessionRepository } from './voice-intent.pg-repository.js';

/**
 * Voice intent-session repository contract tests (Stage 27, Innovation 6).
 * In-memory behavioural contract, plus a pg-style contract over a mock pool
 * asserting the privacy invariant: the ONLY msisdn column written or read
 * is msisdn_hmac (salted HMAC-SHA256 hex) — no plaintext phone exists in
 * the schema (infra/postgres/064_voice_intents.sql) or in any statement.
 */

function fixture(overrides: Partial<VoiceIntentSessionRecord> = {}): VoiceIntentSessionRecord {
  return {
    id: 'vi-1',
    userId: 'user-1',
    channel: 'ivr',
    intent: 'balance.savings',
    msisdnHmac: 'a'.repeat(64),
    result: 'ok',
    durationMs: 1234,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  };
}

describe('InMemoryVoiceIntentSessionRepository', () => {
  it('creates and reads back records', async () => {
    const repo = createInMemoryVoiceIntentSessionRepository();
    await repo.create(fixture());
    expect(await repo.getById('vi-1')).toEqual(fixture());
    expect(await repo.findById('missing')).toBeUndefined();
  });

  it('find filters deterministically (created_at, id order)', async () => {
    const repo = createInMemoryVoiceIntentSessionRepository();
    await repo.create(fixture({ id: 'vi-2', intent: 'voucher.status', result: 'unavailable' }));
    await repo.create(fixture({ id: 'vi-1', createdAt: '2026-08-01T00:00:00.000Z' }));
    expect((await repo.find({})).map((row) => row.id)).toEqual(['vi-1', 'vi-2']);
    expect((await repo.find({ intent: 'voucher.status' })).map((row) => row.id)).toEqual(['vi-2']);
    expect((await repo.find({ result: 'ok' })).map((row) => row.id)).toEqual(['vi-1']);
    expect(await repo.find({ msisdnHmac: 'b'.repeat(64) })).toEqual([]);
  });

  it('stores ONLY the HMAC — a plaintext-shaped value is just another string (service guards)', async () => {
    const repo = createInMemoryVoiceIntentSessionRepository();
    const record = fixture();
    await repo.create(record);
    expect(record.msisdnHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain('+234');
  });
});

/** Minimal pg.Pool mock capturing statements + params. */
function mockPool(rows: Array<Record<string, unknown>> = []) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows, rowCount: rows.length };
    }
  };
  return { pool, queries };
}

describe('PgVoiceIntentSessionRepository (HMAC-only contract)', () => {
  it('INSERT writes msisdn_hmac and never a plaintext phone column', async () => {
    const { pool, queries } = mockPool();
    const repo = new PgVoiceIntentSessionRepository(pool as never);
    await repo.create(fixture({ userId: undefined }));
    expect(queries).toHaveLength(1);
    const { text, values } = queries[0];
    expect(text).toContain('voice.intent_sessions');
    expect(text).toContain('msisdn_hmac');
    expect(text).not.toContain('caller_number');
    expect(text).not.toContain('phone');
    expect(text).not.toContain('msisdn)');
    // user_id null when unset; the HMAC is the 5th column value.
    expect(values[1]).toBeNull();
    expect(values[4]).toBe('a'.repeat(64));
  });

  it('SELECT/filters reference only the HMAC column', async () => {
    const { pool, queries } = mockPool([
      {
        id: 'vi-1',
        user_id: 'user-1',
        channel: 'ivr',
        intent: 'balance.savings',
        msisdn_hmac: 'a'.repeat(64),
        result: 'ok',
        duration_ms: 42,
        created_at: '2026-09-01T00:00:00.000Z'
      }
    ]);
    const repo = new PgVoiceIntentSessionRepository(pool as never);
    const rows = await repo.find({ msisdnHmac: 'a'.repeat(64), result: 'ok' });
    expect(rows).toEqual([fixture({ durationMs: 42 })]);
    for (const { text } of queries) {
      expect(text.toLowerCase()).not.toContain('caller_number');
    }
    expect(queries[0].text).toContain('msisdn_hmac = $1');
    expect(queries[0].values).toEqual(['a'.repeat(64), 'ok']);
  });

  it('getById throws NotFound when the row is absent', async () => {
    const { pool } = mockPool();
    const repo = new PgVoiceIntentSessionRepository(pool as never);
    await expect(repo.getById('nope')).rejects.toThrow('not found');
  });
});
