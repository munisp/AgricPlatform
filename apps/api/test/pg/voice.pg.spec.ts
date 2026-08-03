import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createPgAgentCaseRepository,
  createPgVoiceSessionRepository,
  createPgVoiceTurnRepository
} from '../../src/database/repositories/voice.pg-repository.js';

/**
 * Voice-agronomist pg suite (wave VOICE). Skipped unless DATABASE_URL points
 * at a database with the base schema (001_init.sql) applied — mirroring the
 * existing test/pg pattern:
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/voice.pg.spec.ts
 * Applies infra/postgres/027_voice.sql idempotently, then round-trips the
 * three voice repositories.
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '027_voice.sql'
);

const SESSION_ID = 'vsession-pg-test';
const CASE_ID = 'vcase-pg-test';

describePg('voice schema (027_voice.sql) + pg repositories', () => {
  beforeAll(async () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // Idempotent: applying twice must not error.
    await pool!.query(sql);
    await pool!.query(sql);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM voice.agent_cases WHERE session_id = $1', [SESSION_ID]);
      await pool.query('DELETE FROM voice.voice_turns WHERE session_id = $1', [SESSION_ID]);
      await pool.query('DELETE FROM voice.voice_sessions WHERE id = $1', [SESSION_ID]);
      await pool.end();
    }
  });

  it('migration creates the voice schema tables with indexes', async () => {
    const tables = await pool!.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'voice' ORDER BY table_name"
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'agent_cases',
      'voice_sessions',
      'voice_turns'
    ]);
  });

  it('round-trips a session, its transcript and an agent case', async () => {
    const sessions = createPgVoiceSessionRepository(pool!);
    const turns = createPgVoiceTurnRepository(pool!);
    const cases = createPgAgentCaseRepository(pool!);
    const now = new Date().toISOString();

    await sessions.create({
      id: SESSION_ID,
      channel: 'ussd',
      state: 'intake',
      phone: '+2348012345678',
      ninRef: 'NIN-PG-1',
      locale: 'ha',
      menuState: { menu: 'crop' },
      createdAt: now,
      updatedAt: now
    });
    expect((await sessions.getById(SESSION_ID)).locale).toBe('ha');

    const advanced = await sessions.update(SESSION_ID, { state: 'triage', crop: 'maize' });
    expect(advanced.state).toBe('triage');

    const firstIndex = await turns.nextIndex(SESSION_ID);
    await turns.create({
      id: 'vturn-pg-1',
      sessionId: SESSION_ID,
      turnIndex: firstIndex,
      speaker: 'assistant',
      text: 'Grounded answer',
      citedChunkIds: ['advisory:adv-1:0'],
      confidence: 0.8,
      createdAt: now
    });
    const transcript = await turns.listForSession(SESSION_ID);
    expect(transcript).toHaveLength(1);
    expect(transcript[0].citedChunkIds).toEqual(['advisory:adv-1:0']);
    expect(transcript[0].confidence).toBeCloseTo(0.8);

    await cases.create({
      id: CASE_ID,
      sessionId: SESSION_ID,
      phone: '+2348012345678',
      channel: 'ussd',
      status: 'open',
      reason: 'no_grounding',
      priority: 'high',
      slaDueAt: new Date(Date.now() + 86_400_000).toISOString(),
      citationChunkIds: [],
      createdAt: now,
      updatedAt: now
    });
    const queue = await cases.find({ status: 'open' });
    expect(queue.some((entry) => entry.id === CASE_ID)).toBe(true);

    const resolved = await cases.update(CASE_ID, {
      status: 'resolved',
      assignedAgentId: undefined,
      response: 'Agent reply'
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.response).toBe('Agent reply');
  });
});
