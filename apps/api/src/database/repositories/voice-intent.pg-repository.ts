import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  VoiceIntentChannel,
  VoiceIntentResult,
  VoiceIntentSessionCriteria,
  VoiceIntentSessionRecord,
  VoiceIntentSessionRepository
} from './voice-intent.repository.js';

/**
 * PostgreSQL implementation over voice.intent_sessions
 * (infra/postgres/064_voice_intents.sql). Standalone class (not
 * PgRepositoryBase) so the query shapes stay explicit; behaviour matches
 * the in-memory implementation. The INSERT column list is the privacy
 * contract: msisdn_hmac only — there is no plaintext phone column.
 */
export class PgVoiceIntentSessionRepository implements VoiceIntentSessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VoiceIntentSessionRecord): Promise<VoiceIntentSessionRecord> {
    await this.pool.query(
      'INSERT INTO voice.intent_sessions ' +
        '(id, user_id, channel, intent, msisdn_hmac, result, duration_ms, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        record.id,
        record.userId ?? null,
        record.channel,
        record.intent,
        record.msisdnHmac,
        record.result,
        record.durationMs,
        record.createdAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<VoiceIntentSessionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT id, user_id, channel, intent, msisdn_hmac, result, duration_ms, created_at ' +
        'FROM voice.intent_sessions WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<VoiceIntentSessionRecord> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Voice intent session ${id} not found`);
    }
    return found;
  }

  async find(criteria: VoiceIntentSessionCriteria): Promise<VoiceIntentSessionRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.userId) {
      params.push(criteria.userId);
      clauses.push(`user_id = $${params.length}`);
    }
    if (criteria.msisdnHmac) {
      params.push(criteria.msisdnHmac);
      clauses.push(`msisdn_hmac = $${params.length}`);
    }
    if (criteria.intent) {
      params.push(criteria.intent);
      clauses.push(`intent = $${params.length}`);
    }
    if (criteria.result) {
      params.push(criteria.result);
      clauses.push(`result = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      'SELECT id, user_id, channel, intent, msisdn_hmac, result, duration_ms, created_at ' +
        `FROM voice.intent_sessions${where} ORDER BY created_at, id`,
      params
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): VoiceIntentSessionRecord {
    return {
      id: String(row.id),
      userId: row.user_id === null || row.user_id === undefined ? undefined : String(row.user_id),
      channel: String(row.channel) as VoiceIntentChannel,
      intent: String(row.intent),
      msisdnHmac: String(row.msisdn_hmac),
      result: String(row.result) as VoiceIntentResult,
      durationMs: Number(row.duration_ms),
      createdAt: new Date(String(row.created_at)).toISOString()
    };
  }
}

export function createPgVoiceIntentSessionRepository(pool: pg.Pool): PgVoiceIntentSessionRepository {
  return new PgVoiceIntentSessionRepository(pool);
}
