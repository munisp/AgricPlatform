import { ServiceUnavailableException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  AUTH_UNAVAILABLE,
  KeycloakPhoneTokenService,
  loadKeycloakPhoneAuthConfig
} from './keycloak-phone-token.service.js';

const ENABLED_ENV: NodeJS.ProcessEnv = {
  PHONE_AUTH_KEYCLOAK: 'true',
  OIDC_ISSUER: 'http://keycloak.test/realms/agric-platform',
  KEYCLOAK_CLIENT_ID: 'agric-api',
  KEYCLOAK_CLIENT_SECRET: 'dummy-test-secret-not-real'
};

const user: User = {
  id: 'user-1',
  phone: '+2348010000099',
  fullName: 'Test Farmer',
  roles: ['farmer'],
  preferredLanguage: 'en',
  createdAt: new Date().toISOString()
} as User;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadKeycloakPhoneAuthConfig', () => {
  it('is disabled by default', () => {
    expect(loadKeycloakPhoneAuthConfig({})).toEqual({ enabled: false, timeoutMs: 5000 });
    expect(new KeycloakPhoneTokenService({}).enabled).toBe(false);
  });

  it('resolves the issuer from KEYCLOAK_URL + KEYCLOAK_REALM when OIDC_ISSUER is unset', () => {
    const config = loadKeycloakPhoneAuthConfig({
      PHONE_AUTH_KEYCLOAK: 'true',
      KEYCLOAK_URL: 'http://keycloak.test',
      KEYCLOAK_REALM: 'realm-x',
      KEYCLOAK_CLIENT_ID: 'agric-api'
    });
    expect(config.issuer).toBe('http://keycloak.test/realms/realm-x');
  });

  it('honours PHONE_AUTH_KEYCLOAK_TIMEOUT_MS and falls back on garbage', () => {
    expect(
      loadKeycloakPhoneAuthConfig({ ...ENABLED_ENV, PHONE_AUTH_KEYCLOAK_TIMEOUT_MS: '1234' })
        .timeoutMs
    ).toBe(1234);
    expect(
      loadKeycloakPhoneAuthConfig({ ...ENABLED_ENV, PHONE_AUTH_KEYCLOAK_TIMEOUT_MS: 'soon' })
        .timeoutMs
    ).toBe(5000);
  });
});

describe('KeycloakPhoneTokenService boot config (fail closed)', () => {
  it('aborts boot with ProviderConfigError when enabled without an issuer', () => {
    expect(() => new KeycloakPhoneTokenService({ PHONE_AUTH_KEYCLOAK: 'true' })).toThrow(
      ProviderConfigError
    );
  });

  it('aborts boot with ProviderConfigError when enabled without a client id', () => {
    expect(
      () =>
        new KeycloakPhoneTokenService({
          PHONE_AUTH_KEYCLOAK: 'true',
          OIDC_ISSUER: 'http://keycloak.test/realms/agric-platform'
        })
    ).toThrow(ProviderConfigError);
  });

  it('strips a trailing slash from the issuer before joining the token path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'kc-token' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService({
      ...ENABLED_ENV,
      OIDC_ISSUER: 'http://keycloak.test/realms/agric-platform/'
    });
    await service.issueToken(user, '1234');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://keycloak.test/realms/agric-platform/protocol/openid-connect/token');
  });
});

describe('KeycloakPhoneTokenService.issueToken', () => {
  it('exchanges the verified credential at the token endpoint (direct access grant)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'kc-access-token' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    const token = await service.issueToken(user, '1234');
    expect(token).toBe('kc-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://keycloak.test/realms/agric-platform/protocol/openid-connect/token');
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('client_id=agric-api');
    expect(body).toContain('client_secret=dummy-test-secret-not-real');
    expect(body).toContain(`username=${encodeURIComponent(user.phone)}`);
    expect(body).toContain('password=1234');
  });

  it('omits the client secret when none is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'kc-token' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...ENABLED_ENV };
    delete env['KEYCLOAK_CLIENT_SECRET'];
    const service = new KeycloakPhoneTokenService(env);
    await service.issueToken(user, '1234');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain('client_secret');
  });

  it('fails closed with 503 AUTH_UNAVAILABLE when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService({});
    const error = (await catchError(() => service.issueToken(user, '1234'))) as Error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain(AUTH_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the verified credential is missing (no network call)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    const error = (await catchError(() => service.issueToken(user))) as Error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain(AUTH_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps provider HTTP failures to 503 and redacts the upstream body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream-secret-error-body', { status: 401 }))
    );
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    const error = (await catchError(() => service.issueToken(user, '1234'))) as Error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain(AUTH_UNAVAILABLE);
    // Redaction doctrine: the vendor error body must not leak into the 503.
    expect(error.message).not.toContain('upstream-secret-error-body');
  });

  it('maps transport failures to 503 AUTH_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    const error = (await catchError(() => service.issueToken(user, '1234'))) as Error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain(AUTH_UNAVAILABLE);
  });

  it('maps AbortController timeouts to 503 AUTH_UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          })
      )
    );
    const service = new KeycloakPhoneTokenService({
      ...ENABLED_ENV,
      PHONE_AUTH_KEYCLOAK_TIMEOUT_MS: '20'
    });
    const error = (await catchError(() => service.issueToken(user, '1234'))) as Error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain(AUTH_UNAVAILABLE);
  });

  it('fails closed on a malformed token response (no access_token)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ token_type: 'bearer' })));
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    const error = (await catchError(() => service.issueToken(user, '1234'))) as Error;
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toContain(AUTH_UNAVAILABLE);
  });

  it('opens the circuit breaker after 3 consecutive failures and fail-fasts without network', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    for (let i = 0; i < 3; i += 1) {
      const error = (await catchError(() => service.issueToken(user, '1234'))) as Error;
      expect(error).toBeInstanceOf(ServiceUnavailableException);
    }
    expect(service.circuitOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Open breaker: the next call fails fast without touching the network.
    const blocked = (await catchError(() => service.issueToken(user, '1234'))) as Error;
    expect(blocked).toBeInstanceOf(ServiceUnavailableException);
    expect((blocked as Error).message).toContain(AUTH_UNAVAILABLE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resets the failure counter after a success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('down', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'kc-token' }))
      .mockResolvedValueOnce(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new KeycloakPhoneTokenService(ENABLED_ENV);
    await catchError(() => service.issueToken(user, '1234'));
    await expect(service.issueToken(user, '1234')).resolves.toBe('kc-token');
    await catchError(() => service.issueToken(user, '1234'));
    // Two failures sandwiching a success: the breaker must stay closed.
    expect(service.circuitOpen).toBe(false);
  });
});
