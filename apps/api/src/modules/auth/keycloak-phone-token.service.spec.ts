import { ServiceUnavailableException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import { KeyValueOtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import {
  AUTH_UNAVAILABLE,
  KeycloakPhoneTokenService,
  loadKeycloakPhoneAuthConfig
} from './keycloak-phone-token.service.js';
import { SessionService } from './session.service.js';

const PHONE = '+2348010000001'; // seeded farmer user (in-memory repository)

const KEYCLOAK_ENV: NodeJS.ProcessEnv = {
  PHONE_AUTH_KEYCLOAK: 'true',
  KEYCLOAK_URL: 'https://keycloak.example',
  KEYCLOAK_REALM: 'agric-platform',
  KEYCLOAK_CLIENT_ID: 'agric-api',
  KEYCLOAK_CLIENT_SECRET: 'unit-test-secret'
};

const TOKEN_ENDPOINT = 'https://keycloak.example/realms/agric-platform/protocol/openid-connect/token';

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function hangingFetch() {
  return vi.fn().mockImplementation((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    })
  );
}

function fakeUser(): User {
  return { id: 'user-1', phone: PHONE } as User;
}

function makeAuthService(phoneTokens?: KeycloakPhoneTokenService) {
  const users = new UsersService(createInMemoryUserRepository());
  const auth = new AuthService(
    users,
    new DomainEventsService(createInMemoryOutboxRepository()),
    new MetricsService(),
    new KeyValueOtpChallengeStore(new InMemoryKeyValueStore()),
    new SessionService(users, createInMemoryAuthSessionRepository()),
    phoneTokens
  );
  return { auth, users };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.NODE_ENV;
  delete process.env.PHONE_AUTH_KEYCLOAK;
});

describe('loadKeycloakPhoneAuthConfig', () => {
  it('is disabled by default and only on an explicit true', () => {
    expect(loadKeycloakPhoneAuthConfig({}).enabled).toBe(false);
    expect(loadKeycloakPhoneAuthConfig({ PHONE_AUTH_KEYCLOAK: '1' }).enabled).toBe(false);
    expect(loadKeycloakPhoneAuthConfig({ PHONE_AUTH_KEYCLOAK: 'yes' }).enabled).toBe(false);
    expect(loadKeycloakPhoneAuthConfig({ PHONE_AUTH_KEYCLOAK: ' TRUE ' }).enabled).toBe(true);
  });

  it('derives the issuer from KEYCLOAK_URL + KEYCLOAK_REALM and parses the timeout', () => {
    const config = loadKeycloakPhoneAuthConfig({
      ...KEYCLOAK_ENV,
      PHONE_AUTH_KEYCLOAK_TIMEOUT_MS: '2500'
    });
    expect(config.issuer).toBe('https://keycloak.example/realms/agric-platform');
    expect(config.timeoutMs).toBe(2500);
    expect(config.clientId).toBe('agric-api');
  });
});

describe('KeycloakPhoneTokenService (WP-G16)', () => {
  it('is a no-op when the flag is off', () => {
    const service = new KeycloakPhoneTokenService({});
    expect(service.enabled).toBe(false);
    expect(service.circuitOpen).toBe(false);
  });

  it('aborts boot (ProviderConfigError) when enabled but unconfigured', () => {
    expect(() => new KeycloakPhoneTokenService({ PHONE_AUTH_KEYCLOAK: 'true' })).toThrow(
      ProviderConfigError
    );
    expect(
      () =>
        new KeycloakPhoneTokenService({
          PHONE_AUTH_KEYCLOAK: 'true',
          KEYCLOAK_URL: 'https://keycloak.example'
        })
    ).toThrow(/KEYCLOAK_CLIENT_ID/);
  });

  it('exchanges the verified OTP at the Keycloak token endpoint (password grant)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'kc-access-token' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(KEYCLOAK_ENV);
    const token = await service.issueToken(fakeUser(), '123456');
    expect(token).toBe('kc-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('client_id=agric-api');
    expect(body).toContain('client_secret=unit-test-secret');
    expect(body).toContain('username=%2B2348010000001');
    expect(body).toContain('password=123456');
  });

  it('omits client_secret for a public client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'tok' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...KEYCLOAK_ENV };
    delete env.KEYCLOAK_CLIENT_SECRET;
    const service = new KeycloakPhoneTokenService(env);
    await service.issueToken(fakeUser(), '123456');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain('client_secret');
  });

  it('maps HTTP rejections from the token endpoint to 503 AUTH_UNAVAILABLE', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(KEYCLOAK_ENV);
    const error = await service.issueToken(fakeUser(), '000000').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
    // Token-endpoint error bodies must not leak into the exception message.
    expect((error as Error).message).not.toContain('invalid_grant');
  });

  it('maps transport failures to 503 AUTH_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const service = new KeycloakPhoneTokenService(KEYCLOAK_ENV);
    const error = await service.issueToken(fakeUser(), '123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
  });

  it('times out via AbortController and maps to 503 AUTH_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const service = new KeycloakPhoneTokenService({
      ...KEYCLOAK_ENV,
      PHONE_AUTH_KEYCLOAK_TIMEOUT_MS: '10'
    });
    const error = await service.issueToken(fakeUser(), '123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
  });

  it('opens the circuit breaker after 3 failures and fails fast without fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(KEYCLOAK_ENV);
    for (let i = 0; i < 3; i += 1) {
      const error = await service.issueToken(fakeUser(), '123456').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
    }
    expect(service.circuitOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const error = await service.issueToken(fakeUser(), '123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed on a malformed token response (no access_token)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse({ token_type: 'bearer' })));
    const service = new KeycloakPhoneTokenService(KEYCLOAK_ENV);
    const error = await service.issueToken(fakeUser(), '123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
  });

  it('fails closed without a verified credential and never calls the endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(KEYCLOAK_ENV);
    const error = await service.issueToken(fakeUser()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when constructed disabled', async () => {
    const service = new KeycloakPhoneTokenService({});
    await expect(service.issueToken(fakeUser(), '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });
});

describe('AuthService phone-auth production guard (WP-G16)', () => {
  it('production + flag off: verifyOtp fails closed with 503 and NEVER issues the stub token', async () => {
    process.env.NODE_ENV = 'test';
    const { auth } = makeAuthService();
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    // Flip to production AFTER the dev code was issued; issuance must refuse.
    process.env.NODE_ENV = 'production';
    const error = await auth.verifyOtp(requestId, devCode!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
  });

  it('production + flag off: register and PIN-swap issuance also fail closed', async () => {
    process.env.NODE_ENV = 'production';
    const { auth, users } = makeAuthService();
    await expect(
      auth.register({
        phone: '+2348055550001',
        fullName: 'Prod Guard',
        roles: ['farmer'],
        preferredLanguage: 'en'
      })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const seeded = await users.findByPhone(PHONE);
    await expect(auth.issueSessionFor(seeded!.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('dev/test keeps the stub token behind the explicit non-production path', async () => {
    process.env.NODE_ENV = 'test';
    const { auth } = makeAuthService();
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const session = await auth.verifyOtp(requestId, devCode!);
    expect(session.token).toContain('stub-token.');
    expect(session.user.phone).toBe(PHONE);
  });

  it('flag on: verifyOtp returns the Keycloak-issued token, never the stub', async () => {
    process.env.NODE_ENV = 'test';
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse({ access_token: 'kc-login-token' }));
    vi.stubGlobal('fetch', fetchMock);
    const { auth } = makeAuthService(new KeycloakPhoneTokenService(KEYCLOAK_ENV));
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const session = await auth.verifyOtp(requestId, devCode!);
    expect(session.token).toBe('kc-login-token');
    expect(session.token).not.toContain('stub-token.');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    // The verified OTP code is the exchanged credential.
    expect(String(init.body)).toContain(`password=${devCode}`);
  });

  it('flag on + Keycloak down: verifyOtp maps to 503 AUTH_UNAVAILABLE', async () => {
    process.env.NODE_ENV = 'production';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const { auth } = makeAuthService(new KeycloakPhoneTokenService(KEYCLOAK_ENV));
    // Drive the OTP challenge in a state the service accepts, then fail at issuance.
    process.env.NODE_ENV = 'test';
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    process.env.NODE_ENV = 'production';
    const error = await auth.verifyOtp(requestId, devCode!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(AUTH_UNAVAILABLE);
  });
});
