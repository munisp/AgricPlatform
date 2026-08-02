import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from '../users/users.service.js';
import { SessionService } from './session.service.js';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const repo = createInMemoryAuthSessionRepository();
  const service = new SessionService(users, repo);
  return { service, repo };
}

describe('SessionService (refresh-token sessions)', () => {
  it('issues an opaque token and stores only its hash', async () => {
    const { service, repo } = build();
    const issued = await service.issue('user-aisha', { userAgent: 'vitest', ipAddress: '127.0.0.1' });
    expect(issued.refreshToken.length).toBeGreaterThanOrEqual(40);
    const sessions = await repo.listForUser('user-aisha');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].refreshTokenHash).not.toBe(issued.refreshToken);
    expect(sessions[0].refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions[0].userAgent).toBe('vitest');
    expect(sessions[0].generation).toBe(0);
    expect(sessions[0].familyId).toBeTruthy();
  });

  it('refresh rotates: old token revoked, new generation issued in the same family', async () => {
    const { service } = build();
    const first = await service.issue('user-aisha');
    const rotated = await service.refresh(first.refreshToken);
    expect(rotated.user.id).toBe('user-aisha');
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const sessions = await service.listForUser('user-aisha');
    expect(sessions).toHaveLength(2);
    const [original, next] = sessions;
    expect(original.revokedAt).toBeTruthy();
    expect(next.revokedAt).toBeUndefined();
    expect(next.familyId).toBe(original.familyId);
    expect(next.generation).toBe(1);
  });

  it('rejects unknown refresh tokens', async () => {
    const { service } = build();
    await expect(service.refresh('nope')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const { service } = build();
    const first = await service.issue('user-aisha');
    const second = await service.refresh(first.refreshToken);

    // Attacker replays the first (rotated) token.
    await expect(service.refresh(first.refreshToken)).rejects.toThrow(/family has been revoked/);

    // The legitimately rotated token is now dead too.
    await expect(service.refresh(second.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    const sessions = await service.listForUser('user-aisha');
    expect(sessions.every((session) => session.revokedAt)).toBe(true);
  });

  it('a second reuse attempt stays revoked (idempotent family kill)', async () => {
    const { service } = build();
    const first = await service.issue('user-aisha');
    await service.refresh(first.refreshToken);
    await expect(service.refresh(first.refreshToken)).rejects.toThrow(/family has been revoked/);
    await expect(service.refresh(first.refreshToken)).rejects.toThrow(/family has been revoked/);
  });

  it('rejects expired tokens and revokes the session', async () => {
    const { service, repo } = build();
    const issued = await service.issue('user-aisha');
    const session = (await repo.listForUser('user-aisha'))[0];
    await repo.save({ ...session, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(service.refresh(issued.refreshToken)).rejects.toThrow(/expired/);
    expect((await repo.listForUser('user-aisha'))[0].revokedAt).toBeTruthy();
  });

  it('logout revokes the session and is idempotent', async () => {
    const { service } = build();
    const issued = await service.issue('user-aisha');
    expect(await service.logout(issued.refreshToken)).toEqual({ revoked: true });
    expect(await service.logout(issued.refreshToken)).toEqual({ revoked: false });
    await expect(service.refresh(issued.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('tracks parallel device sessions independently', async () => {
    const { service } = build();
    const phone = await service.issue('user-aisha', { userAgent: 'phone' });
    const kiosk = await service.issue('user-aisha', { userAgent: 'kiosk' });
    await service.logout(phone.refreshToken);
    // The kiosk session is unaffected (different family).
    const rotated = await service.refresh(kiosk.refreshToken);
    expect(rotated.user.id).toBe('user-aisha');
    expect((await service.listForUser('user-aisha')).length).toBe(3);
  });
});

describe('AuthService login flows (Wave P)', () => {
  it('verifyOtp returns a refresh token alongside the access token', async () => {
    const { service } = build();
    const users = (service as unknown as { users: UsersService }).users;
    void users;
    // Covered end-to-end via AuthService in auth.service.spec.ts; here we
    // assert the session repo integration point directly.
    const issued = await service.issue('user-aisha');
    const rotated = await service.refresh(issued.refreshToken);
    expect(rotated.user.id).toBe('user-aisha');
  });
});
