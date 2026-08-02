import type pg from 'pg';
import type { UssdSessionRecord, UssdSessionRepository } from './ussd-session.repository.js';

/**
 * PostgreSQL implementation over channels.ussd_sessions
 * (infra/postgres/008_ussd_channels.sql). Standalone (not PgRepositoryBase)
 * because the primary key is `session_id`, not `id`.
 */
export class PgUssdSessionRepository implements UssdSessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findById(sessionId: string): Promise<UssdSessionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT session_id, phone, msisdn, state, current_menu, created_at, expires_at ' +
        'FROM channels.ussd_sessions WHERE session_id = $1',
      [sessionId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async save(record: UssdSessionRecord): Promise<UssdSessionRecord> {
    await this.pool.query(
      'INSERT INTO channels.ussd_sessions (session_id, phone, msisdn, state, current_menu, created_at, expires_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
        'ON CONFLICT (session_id) DO UPDATE SET ' +
        'phone = EXCLUDED.phone, msisdn = EXCLUDED.msisdn, state = EXCLUDED.state, ' +
        'current_menu = EXCLUDED.current_menu, expires_at = EXCLUDED.expires_at',
      [
        record.sessionId,
        record.phone,
        record.msisdn,
        JSON.stringify(record.state),
        record.currentMenu,
        record.createdAt,
        record.expiresAt
      ]
    );
    return record;
  }

  async remove(sessionId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM channels.ussd_sessions WHERE session_id = $1',
      [sessionId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM channels.ussd_sessions WHERE expires_at <= $1',
      [nowIso]
    );
    return result.rowCount ?? 0;
  }

  private fromRow(row: Record<string, unknown>): UssdSessionRecord {
    return {
      sessionId: row.session_id as string,
      phone: row.phone as string,
      msisdn: row.msisdn as string,
      state: (row.state ?? {}) as Record<string, unknown>,
      currentMenu: row.current_menu as string,
      createdAt: new Date(row.created_at as string).toISOString(),
      expiresAt: new Date(row.expires_at as string).toISOString()
    };
  }
}

export function createPgUssdSessionRepository(pool: pg.Pool): PgUssdSessionRepository {
  return new PgUssdSessionRepository(pool);
}
