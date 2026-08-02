import type pg from 'pg';
import type { AuthSession, AuthSessionRepository } from './auth-session.repository.js';

interface AuthSessionRow {
  id: string;
  user_id: string;
  family_id: string | null;
  generation: number;
  refresh_token_hash: string;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

function fromRow(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    // Rows predating the family column were backfilled with their own id.
    familyId: row.family_id ?? row.id,
    generation: row.generation,
    refreshTokenHash: row.refresh_token_hash,
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    ...(row.ip_address ? { ipAddress: row.ip_address } : {}),
    expiresAt: row.expires_at.toISOString(),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at.toISOString() } : {}),
    createdAt: row.created_at.toISOString()
  };
}

const COLUMNS =
  'id, user_id, family_id, generation, refresh_token_hash, user_agent, ip_address, ' +
  'expires_at, revoked_at, last_used_at, created_at';

/** identity.auth_sessions (Wave P refresh-token sessions). */
export class PgAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(session: AuthSession): Promise<AuthSession> {
    await this.pool.query(
      `INSERT INTO identity.auth_sessions
         (id, user_id, family_id, generation, refresh_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        session.id,
        session.userId,
        session.familyId,
        session.generation,
        session.refreshTokenHash,
        session.userAgent ?? null,
        session.ipAddress ?? null,
        session.expiresAt
      ]
    );
    return session;
  }

  async findByTokenHash(refreshTokenHash: string): Promise<AuthSession | undefined> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM identity.auth_sessions WHERE refresh_token_hash = $1`,
      [refreshTokenHash]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async save(session: AuthSession): Promise<AuthSession> {
    await this.pool.query(
      `UPDATE identity.auth_sessions
          SET revoked_at = $2, last_used_at = $3, generation = $4
        WHERE id = $1`,
      [session.id, session.revokedAt ?? null, session.lastUsedAt ?? null, session.generation]
    );
    return session;
  }

  async revokeFamily(familyId: string, revokedAt: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE identity.auth_sessions
          SET revoked_at = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, revokedAt]
    );
    return result.rowCount ?? 0;
  }

  async listForUser(userId: string): Promise<AuthSession[]> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM identity.auth_sessions WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    return result.rows.map(fromRow);
  }
}

export function createPgAuthSessionRepository(pool: pg.Pool): PgAuthSessionRepository {
  return new PgAuthSessionRepository(pool);
}
