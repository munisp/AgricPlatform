import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { AUTH_SESSION_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  AuthSession,
  AuthSessionRepository
} from '../../database/repositories/auth-session.repository.js';
import { UsersService } from '../users/users.service.js';

/** Refresh-token lifetime: 30 days (env-overridable for tests/ops). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Absolute session-family lifetime in days (SESSION_FAMILY_MAX_AGE_DAYS):
 * even a diligently rotated family must re-authenticate once its oldest
 * session passes this cap, so a stolen token cannot live forever.
 */
export const SESSION_FAMILY_MAX_AGE_DAYS = 90;

export interface SessionClientMeta {
  userAgent?: string;
  ipAddress?: string;
}

export interface IssuedRefreshToken {
  refreshToken: string;
  expiresAt: string;
}

/**
 * Refresh-token sessions (Wave P). Opaque tokens are minted at login, stored
 * sha256-hashed in identity.auth_sessions, and rotated on every refresh:
 * the presented token is revoked and a new generation is issued inside the
 * same family. Presenting an already-rotated (revoked) token is treated as
 * theft: the entire family is revoked so every derived session dies.
 *
 * This augments the existing stub-token/OIDC access-token flows; it does not
 * change their semantics.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly users: UsersService,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository
  ) {}

  /** Mints the first generation of a new session family. */
  async issue(userId: string, meta: SessionClientMeta = {}): Promise<IssuedRefreshToken> {
    return this.mint(userId, randomUUID(), 0, meta);
  }

  /**
   * Rotates a refresh token. Returns the authenticated user plus the next
   * token generation. Throws UnauthorizedException for unknown, expired, or
   * revoked tokens; reuse of a rotated token revokes the whole family.
   */
  async refresh(
    refreshToken: string,
    meta: SessionClientMeta = {}
  ): Promise<{ user: User } & IssuedRefreshToken> {
    const session = await this.sessions.findByTokenHash(this.hash(refreshToken));
    if (!session) {
      throw new UnauthorizedException('Unknown refresh token');
    }
    if (session.revokedAt) {
      // Reuse of an already-rotated token: revoke the entire family.
      const revoked = await this.sessions.revokeFamily(session.familyId, new Date().toISOString());
      this.logger.warn(
        `Refresh-token reuse detected (session ${session.id}); revoked ${revoked} session(s) ` +
          `in family ${session.familyId}`
      );
      throw new UnauthorizedException(
        'Refresh token was already rotated; the session family has been revoked. Sign in again.'
      );
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.sessions.save({ ...session, revokedAt: new Date().toISOString() });
      throw new UnauthorizedException('Refresh token expired');
    }
    // Suspended accounts must not extend their sessions: reject and kill the
    // family so no generation minted before the suspension stays usable.
    if ((await this.users.statusFor(session.userId)) === 'suspended') {
      await this.sessions.revokeFamily(session.familyId, new Date().toISOString());
      throw new UnauthorizedException('Account is suspended; the session family has been revoked.');
    }
    // Absolute family cap: rotation cannot extend a family past its maximum
    // age (measured from the family's oldest session).
    if (await this.familyExpired(session)) {
      await this.sessions.revokeFamily(session.familyId, new Date().toISOString());
      throw new UnauthorizedException(
        'Session family has reached its maximum lifetime; sign in again.'
      );
    }
    // Rotate with a guarded check-and-set (revoked_at IS NULL): two
    // concurrent refreshes of the same token no longer both mint the next
    // generation — exactly one wins the CAS, the loser is treated like
    // token reuse and the whole family is revoked.
    const now = new Date().toISOString();
    try {
      await this.sessions.updateExpected(
        session.id,
        { revokedAt: now, lastUsedAt: now },
        { revokedAt: undefined }
      );
    } catch (error) {
      if (error instanceof ConflictException) {
        const revoked = await this.sessions.revokeFamily(session.familyId, now);
        this.logger.warn(
          `Concurrent refresh lost the rotation race (session ${session.id}); ` +
            `revoked ${revoked} session(s) in family ${session.familyId}`
        );
        throw new UnauthorizedException(
          'Refresh token was already rotated; the session family has been revoked. Sign in again.'
        );
      }
      throw error;
    }
    const next = await this.mint(session.userId, session.familyId, session.generation + 1, meta);
    const user = await this.users.getById(session.userId);
    return { user, ...next };
  }

  /** True when the session's family is older than the absolute cap. */
  private async familyExpired(session: AuthSession): Promise<boolean> {
    const family = (await this.sessions.listForUser(session.userId)).filter(
      (member) => member.familyId === session.familyId
    );
    const oldest = family.reduce<string>(
      (min, member) => (member.createdAt < min ? member.createdAt : min),
      session.createdAt
    );
    return new Date(oldest).getTime() + this.familyMaxAgeMs() <= Date.now();
  }

  private familyMaxAgeMs(): number {
    const configured = Number(process.env.SESSION_FAMILY_MAX_AGE_DAYS);
    const days =
      Number.isFinite(configured) && configured > 0 ? configured : SESSION_FAMILY_MAX_AGE_DAYS;
    return days * 24 * 60 * 60 * 1000;
  }

  /** Idempotent logout: revokes the presented token's session. */
  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    const session = await this.sessions.findByTokenHash(this.hash(refreshToken));
    if (!session || session.revokedAt) {
      return { revoked: false };
    }
    await this.sessions.save({ ...session, revokedAt: new Date().toISOString() });
    return { revoked: true };
  }

  async listForUser(userId: string): Promise<AuthSession[]> {
    return this.sessions.listForUser(userId);
  }

  private async mint(
    userId: string,
    familyId: string,
    generation: number,
    meta: SessionClientMeta
  ): Promise<IssuedRefreshToken> {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs()).toISOString();
    const session: AuthSession = {
      id: randomUUID(),
      userId,
      familyId,
      generation,
      refreshTokenHash: this.hash(refreshToken),
      ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
      ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      expiresAt,
      createdAt: new Date().toISOString()
    };
    await this.sessions.create(session);
    return { refreshToken, expiresAt };
  }

  private ttlMs(): number {
    const configured = Number(process.env.REFRESH_TOKEN_TTL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : REFRESH_TOKEN_TTL_MS;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
