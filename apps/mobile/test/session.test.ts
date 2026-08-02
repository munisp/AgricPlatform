import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../src/api/client';
import { createInMemoryTokenStore } from '../src/api/token-store';

/**
 * Wave A session wiring: refresh-token rotation on 401, single-flight
 * behaviour, reuse-revoke handling and logout revocation.
 */

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeClient(responder: (call: RecordedCall, index: number) => Response) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  const tokenStore = createInMemoryTokenStore();
  const onSessionExpired = vi.fn();
  const client = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore,
    fetchImpl,
    onSessionExpired
  });
  return { client, tokenStore, calls, onSessionExpired };
}

describe('token store session halves', () => {
  it('persists access + refresh tokens and clears both', async () => {
    const store = createInMemoryTokenStore();
    await store.setSession({ token: 'access-1', refreshToken: 'refresh-1' });
    expect(await store.getToken()).toBe('access-1');
    expect(await store.getRefreshToken()).toBe('refresh-1');
    await store.clear();
    expect(await store.getToken()).toBeNull();
    expect(await store.getRefreshToken()).toBeNull();
  });

  it('setSession keeps the access token when rotation returns none', async () => {
    const store = createInMemoryTokenStore();
    await store.setSession({ token: 'access-1', refreshToken: 'refresh-1' });
    await store.setSession({ refreshToken: 'refresh-2' });
    expect(await store.getToken()).toBe('access-1');
    expect(await store.getRefreshToken()).toBe('refresh-2');
  });
});

describe('api client refresh-token flow', () => {
  it('rotates the refresh token on 401 and retries once with the same idempotency key', async () => {
    const { client, tokenStore, calls } = makeClient((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        return jsonResponse({ data: { user: { id: 'u1' }, refreshToken: 'refresh-2' } });
      }
      const auth = (call.init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer access-1' && call.url.endsWith('/orders')
        ? jsonResponse({ message: 'token expired' }, 401)
        : jsonResponse({ data: [] });
    });
    await tokenStore.setSession({ token: 'access-1', refreshToken: 'refresh-1' });

    const result = await client.apiFetch('/orders', {
      method: 'POST',
      body: { listingId: 'l1' },
      idempotencyKey: 'idem-order-1'
    });

    expect(result).toEqual({ data: [] });
    // Refresh happened exactly once, presenting the old token.
    const refresh = calls.find((call) => call.url.endsWith('/auth/refresh'));
    expect(JSON.parse(String(refresh?.init?.body))).toEqual({ refreshToken: 'refresh-1' });
    // The retry (third call) reused the original idempotency key.
    const orderCalls = calls.filter((call) => call.url.endsWith('/orders'));
    expect(orderCalls).toHaveLength(2);
    const keys = orderCalls.map(
      (call) => (call.init?.headers as Record<string, string>)['Idempotency-Key']
    );
    expect(keys).toEqual(['idem-order-1', 'idem-order-1']);
    // Rotation was persisted.
    expect(await tokenStore.getRefreshToken()).toBe('refresh-2');
  });

  it('shares one refresh across concurrent 401s (single-flight)', async () => {
    const { client, tokenStore, calls } = makeClient((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        return jsonResponse({ data: { user: { id: 'u1' }, refreshToken: 'refresh-2' } });
      }
      const refreshed = (call.init?.headers as Record<string, string>)['X-Refreshed'];
      return refreshed ? jsonResponse({ data: [] }) : jsonResponse({ message: 'expired' }, 401);
    });
    await tokenStore.setSession({ token: 'access-1', refreshToken: 'refresh-1' });

    // Both fail with 401; both should await the same rotation promise.
    await Promise.all([
      client.apiFetch('/a').catch(() => null),
      client.apiFetch('/b').catch(() => null)
    ]);
    const refreshes = calls.filter((call) => call.url.endsWith('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('clears the session and notifies when rotation is rejected (reuse-revoke)', async () => {
    const { client, tokenStore, onSessionExpired } = makeClient((call) => {
      if (call.url.endsWith('/auth/refresh')) {
        return jsonResponse(
          { message: 'Refresh token was already rotated; the session family has been revoked. Sign in again.' },
          401
        );
      }
      return jsonResponse({ message: 'expired' }, 401);
    });
    await tokenStore.setSession({ token: 'access-1', refreshToken: 'revoked-token' });

    await expect(client.apiFetch('/orders')).rejects.toThrowError(ApiError);
    expect(await tokenStore.getToken()).toBeNull();
    expect(await tokenStore.getRefreshToken()).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('propagates the 401 without a refresh call when no refresh token exists', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ message: 'expired' }, 401));
    await expect(client.apiFetch('/orders')).rejects.toThrowError(ApiError);
    expect(calls.some((call) => call.url.endsWith('/auth/refresh'))).toBe(false);
  });

  it('does not trigger refresh for non-401 errors', async () => {
    const { client, tokenStore, calls } = makeClient(() =>
      jsonResponse({ message: 'server exploded' }, 500)
    );
    await tokenStore.setSession({ token: 'access-1', refreshToken: 'refresh-1' });
    await expect(client.apiFetch('/orders')).rejects.toThrowError('server exploded');
    expect(calls).toHaveLength(1);
  });

  it('never loops refresh on the auth endpoints themselves', async () => {
    const { client, tokenStore, calls, onSessionExpired } = makeClient(() =>
      jsonResponse({ message: 'unknown refresh token' }, 401)
    );
    await tokenStore.setSession({ token: 'access-1', refreshToken: 'refresh-1' });
    await expect(
      client.apiFetch('/auth/refresh', { method: 'POST', body: { refreshToken: 'refresh-1' } })
    ).rejects.toThrowError(ApiError);
    expect(calls).toHaveLength(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});
