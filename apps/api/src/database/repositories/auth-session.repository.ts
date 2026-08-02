/**
 * Refresh-token auth sessions (identity.auth_sessions). Wave P activates the
 * table: sessions persist opaque refresh tokens (sha256 at rest), device
 * metadata, and rotation family tracking so a replayed rotated token revokes
 * the entire family.
 */
export interface AuthSession {
  id: string;
  userId: string;
  /** All token generations minted from one login share a family id. */
  familyId: string;
  /** Rotation counter inside the family (0 = initial login token). */
  generation: number;
  refreshTokenHash: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface AuthSessionRepository {
  create(session: AuthSession): Promise<AuthSession>;
  findByTokenHash(refreshTokenHash: string): Promise<AuthSession | undefined>;
  /** Persists rotation/revocation state changes for an existing session. */
  save(session: AuthSession): Promise<AuthSession>;
  /** Revokes every session in the family; returns the number newly revoked. */
  revokeFamily(familyId: string, revokedAt: string): Promise<number>;
  /** Revokes every session the user holds (all families); returns the number newly revoked. */
  revokeAllForUser(userId: string, revokedAt: string): Promise<number>;
  listForUser(userId: string): Promise<AuthSession[]>;
}

export class InMemoryAuthSessionRepository implements AuthSessionRepository {
  private readonly sessions = new Map<string, AuthSession>();

  async create(session: AuthSession): Promise<AuthSession> {
    this.sessions.set(session.id, { ...session });
    return session;
  }

  async findByTokenHash(refreshTokenHash: string): Promise<AuthSession | undefined> {
    for (const session of this.sessions.values()) {
      if (session.refreshTokenHash === refreshTokenHash) {
        return { ...session };
      }
    }
    return undefined;
  }

  async save(session: AuthSession): Promise<AuthSession> {
    this.sessions.set(session.id, { ...session });
    return session;
  }

  async revokeFamily(familyId: string, revokedAt: string): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.familyId === familyId && !session.revokedAt) {
        session.revokedAt = revokedAt;
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeAllForUser(userId: string, revokedAt: string): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = revokedAt;
        revoked += 1;
      }
    }
    return revoked;
  }

  async listForUser(userId: string): Promise<AuthSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map((session) => ({ ...session }));
  }
}

export function createInMemoryAuthSessionRepository(): InMemoryAuthSessionRepository {
  return new InMemoryAuthSessionRepository();
}
