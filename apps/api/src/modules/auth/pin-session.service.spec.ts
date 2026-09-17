import { HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { MetricsService } from '../../common/metrics/metrics.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryPinProfileRepository } from '../../database/repositories/pin-profile.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import type { OtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { AUTH_UNAVAILABLE, KeycloakPhoneTokenService } from './keycloak-phone-token.service.js';
import { PinSessionService } from './pin-session.service.js';
import { SessionService } from './session.service.js';

const DEVICE = 'device-token-aaaa';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const events = { publish: vi.fn(async () => ({})) } as unknown as DomainEventsService;
  const metrics = {} as unknown as MetricsService;
  const otp = {} as unknown as OtpChallengeStore;
  const auth = new AuthService(
    users,
    events,
    metrics,
    otp,
    new SessionService(users, createInMemoryAuthSessionRepository())
  );
  const profiles = createInMemoryPinProfileRepository();
  const service = new PinSessionService(profiles, users, auth, events);
  return { service, users, profiles, events, auth };
}

/**
 * PIN-swap stack with the flagged Keycloak issuer injected (the credential
 * threading path): env carries obvious dummy values only — no real secrets.
 */
function buildFlagged(env: NodeJS.ProcessEnv) {
  const users = new UsersService(createInMemoryUserRepository());
  const events = { publish: vi.fn(async () => ({})) } as unknown as DomainEventsService;
  const metrics = {} as unknown as MetricsService;
  const otp = {} as unknown as OtpChallengeStore;
  const keycloak = new KeycloakPhoneTokenService(env);
  const auth = new AuthService(
    users,
    events,
    metrics,
    otp,
    new SessionService(users, createInMemoryAuthSessionRepository()),
    keycloak
  );
  const profiles = createInMemoryPinProfileRepository();
  const service = new PinSessionService(profiles, users, auth, events);
  return { service, users, profiles, events, auth, keycloak };
}

const FLAGGED_ENV: NodeJS.ProcessEnv = {
  PHONE_AUTH_KEYCLOAK: 'true',
  OIDC_ISSUER: 'http://keycloak.test/realms/agric-platform',
  KEYCLOAK_CLIENT_ID: 'agric-api',
  KEYCLOAK_CLIENT_SECRET: 'dummy-test-secret-not-real'
};

async function makeUser(users: UsersService, phone: string, name: string): Promise<User> {
  return users.create({ phone, fullName: name, roles: ['farmer'], preferredLanguage: 'en' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PinSessionService', () => {
  it('stores only the salted hash, never the raw PIN', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234900', 'Parent One');
    await service.addProfile(user.id, DEVICE, '1234');
    const stored = await profiles.find(DEVICE, user.id);
    expect(stored?.pinHash).toBe(service.hashPin(DEVICE, user.id, '1234'));
    expect(JSON.stringify(stored)).not.toContain('1234');
  });

  it('salts the hash per device and user', async () => {
    const { service } = build();
    expect(service.hashPin('device-1', 'user-1', '1234')).not.toBe(service.hashPin('device-2', 'user-1', '1234'));
    expect(service.hashPin('device-1', 'user-1', '1234')).not.toBe(service.hashPin('device-1', 'user-2', '1234'));
  });

  it('enforces the 5-profiles-per-device cap', async () => {
    const { service, users } = build();
    for (let i = 0; i < 5; i += 1) {
      const user = await makeUser(users, `+23491${i}`, `Member ${i}`);
      await service.addProfile(user.id, DEVICE, '1234');
    }
    const sixth = await makeUser(users, '+234915', 'Member 6');
    await expect(service.addProfile(sixth.id, DEVICE, '1234')).rejects.toThrow(/maximum of 5 profiles/);
    // …but the cap does not follow the user to a different device.
    await expect(service.addProfile(sixth.id, 'device-token-bbbb', '1234')).resolves.toMatchObject({
      profilesOnDevice: 1
    });
  });

  it('re-pinning the same user updates the PIN without growing the device', async () => {
    const { service, users } = build();
    const user = await makeUser(users, '+234920', 'Re Pin');
    await service.addProfile(user.id, DEVICE, '1234');
    const view = await service.addProfile(user.id, DEVICE, '4321');
    expect(view.profilesOnDevice).toBe(1);
    await expect(service.switchProfile(DEVICE, user.id, '1234')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(service.switchProfile(DEVICE, user.id, '4321')).resolves.toMatchObject({
      user: { id: user.id }
    });
  });

  it('rejects malformed PINs', async () => {
    const { service, users } = build();
    const user = await makeUser(users, '+234921', 'Bad Pin');
    await expect(service.addProfile(user.id, DEVICE, '12345')).rejects.toThrow(/4 digits/);
    await expect(service.addProfile(user.id, DEVICE, 'abcd')).rejects.toThrow(/4 digits/);
    await expect(service.switchProfile(DEVICE, user.id, '12 4')).rejects.toThrow(/4 digits/);
  });

  it('issues a session on the correct PIN and resets attempts', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234922', 'Swap Me');
    await service.addProfile(user.id, DEVICE, '1234');
    await expect(service.switchProfile(DEVICE, user.id, '0000')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    expect((await profiles.find(DEVICE, user.id))?.attempts).toBe(1);
    const result = await service.switchProfile(DEVICE, user.id, '1234');
    expect(result.token.startsWith('stub-token.')).toBe(true);
    expect(result.user.id).toBe(user.id);
    expect((await profiles.find(DEVICE, user.id))?.attempts).toBe(0);
  });

  it('locks the profile after 5 wrong PINs for 15 minutes', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234923', 'Lock Me');
    await service.addProfile(user.id, DEVICE, '1234');
    for (let i = 0; i < 4; i += 1) {
      await expect(service.switchProfile(DEVICE, user.id, '9999')).rejects.toBeInstanceOf(
        UnauthorizedException
      );
    }
    // 5th wrong PIN trips the lockout with a 429.
    const fifth = await service.switchProfile(DEVICE, user.id, '9999').catch((error) => error);
    expect(fifth).toBeInstanceOf(HttpException);
    expect((fifth as HttpException).getStatus()).toBe(429);
    const locked = await profiles.find(DEVICE, user.id);
    expect(locked?.lockedUntil).toBeDefined();
    // Even the correct PIN is rejected while locked.
    const duringLock = await service.switchProfile(DEVICE, user.id, '1234').catch((error) => error);
    expect((duringLock as HttpException).getStatus()).toBe(429);
  });

  it('accepts the correct PIN again once the lock has expired', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234924', 'Unlock Me');
    await service.addProfile(user.id, DEVICE, '1234');
    for (let i = 0; i < 5; i += 1) {
      await service.switchProfile(DEVICE, user.id, '9999').catch(() => undefined);
    }
    // Simulate the lockout window passing.
    await profiles.update(DEVICE, user.id, {
      lockedUntil: new Date(Date.now() - 1000).toISOString()
    });
    await expect(service.switchProfile(DEVICE, user.id, '1234')).resolves.toMatchObject({
      user: { id: user.id }
    });
    const after = await profiles.find(DEVICE, user.id);
    expect(after?.lockedUntil).toBeUndefined();
    expect(after?.attempts).toBe(0);
  });

  it('counts concurrent wrong PINs exactly — parallel bursts cannot defeat the lockout (C2-5)', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234927', 'Race Me');
    await service.addProfile(user.id, DEVICE, '1234');
    // Fire a parallel burst of wrong PINs against the service.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.switchProfile(DEVICE, user.id, '9999'))
    );
    // Every guess was rejected; none slipped through as a success.
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    // The atomic counter reached the lockout threshold despite concurrency.
    const rejected = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as HttpException);
    expect(rejected.some((error) => error.getStatus?.() === 429)).toBe(true);
    const locked = await profiles.find(DEVICE, user.id);
    expect(locked?.lockedUntil).toBeDefined();
    // …and even the correct PIN is refused while locked.
    const duringLock = await service.switchProfile(DEVICE, user.id, '1234').catch((error) => error);
    expect((duringLock as HttpException).getStatus()).toBe(429);
  });

  it('incrementAttempts is atomic in the in-memory repository (no lost updates)', async () => {
    const { service, users, profiles } = build();
    const user = await makeUser(users, '+234928', 'Repo Race');
    await service.addProfile(user.id, DEVICE, '1234');
    const counts = await Promise.all(
      Array.from({ length: 20 }, () => profiles.incrementAttempts(DEVICE, user.id))
    );
    expect(Math.max(...counts)).toBe(20);
    expect((await profiles.find(DEVICE, user.id))?.attempts).toBe(20);
  });

  it('rejects unknown device profiles', async () => {
    const { service } = build();
    await expect(service.switchProfile(DEVICE, 'user-nope', '1234')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('lists device profiles without exposing hashes', async () => {
    const { service, users } = build();
    const a = await makeUser(users, '+234925', 'List A');
    const b = await makeUser(users, '+234926', 'List B');
    await service.addProfile(a.id, DEVICE, '1234');
    await service.addProfile(b.id, DEVICE, '1234');
    const list = await service.listProfiles(DEVICE, a);
    expect(list.map((profile) => profile.userId).sort()).toEqual([a.id, b.id].sort());
    expect(JSON.stringify(list)).not.toContain('pinHash');
  });

  it('refuses profile listing to a caller not pinned on the device (V-60)', async () => {
    const { service, users } = build();
    const a = await makeUser(users, '+234927', 'Pinned');
    const outsider = await makeUser(users, '+234928', 'Outsider');
    await service.addProfile(a.id, DEVICE, '1234');
    await expect(service.listProfiles(DEVICE, outsider)).rejects.toThrowError(NotFoundException);
    // 404, not 403: no token-existence signal.
    const error = await service.listProfiles(DEVICE, outsider).catch((e) => e);
    expect(error.getStatus?.()).toBe(404);
    // The pinned caller still lists.
    await expect(service.listProfiles(DEVICE, a)).resolves.toHaveLength(1);
  });

  it('refuses profile listing on weak (short) device tokens, even for admins (V-60)', async () => {
    const { service, users } = build();
    const admin = await users.create({
      phone: '+234929',
      fullName: 'Admin',
      roles: ['admin'],
      preferredLanguage: 'en'
    });
    await expect(service.listProfiles('kiosk-1', admin)).rejects.toThrowError(NotFoundException);
    await expect(service.listProfiles('device-token-aaaa', admin)).resolves.toEqual([]);
  });
});

describe('PinSessionService credential threading (Stage-2 follow-up)', () => {
  it('threads the verified PIN into token issuance as the credential', async () => {
    const { service, users, auth } = build();
    const user = await makeUser(users, '+234930', 'Thread Me');
    await service.addProfile(user.id, DEVICE, '1234');
    const spy = vi.spyOn(auth, 'issueSessionFor');
    await service.switchProfile(DEVICE, user.id, '1234');
    expect(spy).toHaveBeenCalledWith(user.id, undefined, '1234');
  });

  it('never reaches token issuance on a wrong PIN (no credential threaded)', async () => {
    const { service, users, auth } = build();
    const user = await makeUser(users, '+234931', 'Wrong Pin');
    await service.addProfile(user.id, DEVICE, '1234');
    const spy = vi.spyOn(auth, 'issueSessionFor');
    await expect(service.switchProfile(DEVICE, user.id, '9999')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('flag on + configured: the PIN swap exchanges the verified PIN at Keycloak', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'kc-pin-swap-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { service, users } = buildFlagged(FLAGGED_ENV);
    const user = await makeUser(users, '+234932', 'Flag Swap');
    await service.addProfile(user.id, DEVICE, '1234');
    const result = await service.switchProfile(DEVICE, user.id, '1234');
    expect(result.token).toBe('kc-pin-swap-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://keycloak.test/realms/agric-platform/protocol/openid-connect/token');
    const body = String(init.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain(`username=${encodeURIComponent('+234932')}`);
    expect(body).toContain('password=1234');
    // Refresh-session contract is preserved alongside the swapped token.
    expect(result.refreshToken).toBeTruthy();
  });

  it('flag on + unconfigured: boot aborts with ProviderConfigError', () => {
    expect(() => new KeycloakPhoneTokenService({ PHONE_AUTH_KEYCLOAK: 'true' })).toThrow(
      ProviderConfigError
    );
    expect(
      () =>
        new KeycloakPhoneTokenService({
          PHONE_AUTH_KEYCLOAK: 'true',
          OIDC_ISSUER: 'http://keycloak.test/realms/agric-platform'
        })
    ).toThrow(ProviderConfigError);
  });

  it('flag on + vendor down: the PIN swap fails closed with 503 AUTH_UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('vendor-secret-error', { status: 500 }))
    );
    const { service, users } = buildFlagged(FLAGGED_ENV);
    const user = await makeUser(users, '+234933', 'Vendor Down');
    await service.addProfile(user.id, DEVICE, '1234');
    const error = await service.switchProfile(DEVICE, user.id, '1234').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
    // Redaction doctrine: the vendor error body must not leak into the 503.
    expect((error as Error).message).not.toContain('vendor-secret-error');
  });

  it('flag on + no credential threaded: issuance fails closed with 503 (placeholder semantics)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { auth, users } = buildFlagged(FLAGGED_ENV);
    const user = await makeUser(users, '+234934', 'No Credential');
    const error = await auth.issueSessionFor(user.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag off: the threaded credential is ignored and the dev stub path decides', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service, users } = build();
    const user = await makeUser(users, '+234935', 'Flag Off');
    await service.addProfile(user.id, DEVICE, '1234');
    const result = await service.switchProfile(DEVICE, user.id, '1234');
    expect(result.token.startsWith('stub-token.')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
