import type pg from 'pg';
import type { IvrCallRecord, IvrCallRepository } from './ivr-call.repository.js';

/**
 * PostgreSQL implementation over channels.ivr_calls
 * (infra/postgres/011_ivr.sql). Standalone (not PgRepositoryBase) because the
 * primary key is `session_id`, not `id`.
 */
export class PgIvrCallRepository implements IvrCallRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findById(sessionId: string): Promise<IvrCallRecord | undefined> {
    const result = await this.pool.query(
      'SELECT session_id, caller_number, state, current_menu, dtmf_history, outcome, ' +
        'created_at, updated_at, expires_at ' +
        'FROM channels.ivr_calls WHERE session_id = $1',
      [sessionId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async save(record: IvrCallRecord): Promise<IvrCallRecord> {
    await this.pool.query(
      'INSERT INTO channels.ivr_calls ' +
        '(session_id, caller_number, state, current_menu, dtmf_history, outcome, ' +
        'created_at, updated_at, expires_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ' +
        'ON CONFLICT (session_id) DO UPDATE SET ' +
        'caller_number = EXCLUDED.caller_number, state = EXCLUDED.state, ' +
        'current_menu = EXCLUDED.current_menu, dtmf_history = EXCLUDED.dtmf_history, ' +
        'outcome = EXCLUDED.outcome, updated_at = EXCLUDED.updated_at, ' +
        'expires_at = EXCLUDED.expires_at',
      [
        record.sessionId,
        record.callerNumber,
        JSON.stringify(record.state),
        record.currentMenu,
        record.dtmfHistory,
        record.outcome ?? null,
        record.createdAt,
        record.updatedAt,
        record.expiresAt
      ]
    );
    return record;
  }

  async remove(sessionId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM channels.ivr_calls WHERE session_id = $1',
      [sessionId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM channels.ivr_calls WHERE expires_at <= $1',
      [nowIso]
    );
    return result.rowCount ?? 0;
  }

  private fromRow(row: Record<string, unknown>): IvrCallRecord {
    return {
      sessionId: row.session_id as string,
      callerNumber: row.caller_number as string,
      state: (row.state ?? {}) as Record<string, unknown>,
      currentMenu: row.current_menu as string,
      dtmfHistory: (row.dtmf_history as string) ?? '',
      outcome: (row.outcome as string | null) ?? undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
      expiresAt: new Date(row.expires_at as string).toISOString()
    };
  }
}

export function createPgIvrCallRepository(pool: pg.Pool): PgIvrCallRepository {
  return new PgIvrCallRepository(pool);
}
