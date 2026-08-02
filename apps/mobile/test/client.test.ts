import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../src/api/client';
import { createInMemoryTokenStore } from '../src/api/token-store';

function makeClient(routes: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    for (const [route, body] of Object.entries(routes)) {
      if (path.endsWith(route)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  const tokenStore = createInMemoryTokenStore();
  const client = createApiClient({ baseUrl: 'https://api.test/api/v1', tokenStore, fetchImpl });
  return { client, tokenStore, calls };
}

describe('mobile api client', () => {
  it('builds URLs from the configured base, path and query (dropping empty values)', () => {
    const { client } = makeClient();
    expect(client.buildUrl('/courses', { category: 'crops', page: 2, type: undefined, state: '' })).toBe(
      'https://api.test/api/v1/courses?category=crops&page=2'
    );
    expect(client.buildUrl('courses')).toBe('https://api.test/api/v1/courses');
  });

  it('attaches the bearer token from the token store', async () => {
    const { client, tokenStore, calls } = makeClient({ '/auth/session': { data: { user: { id: 'u1' } } } });
    await tokenStore.setToken('stub-token.abc');
    await client.apiFetch('/auth/session');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer stub-token.abc');
  });

  it('omits the Authorization header when no token is stored', async () => {
    const { client, calls } = makeClient({ '/courses': { data: [], total: 0, page: 1, pageSize: 20 } });
    await client.apiFetch('/courses');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('adds an idempotency key to mutations and honours a provided key', async () => {
    const { client, calls } = makeClient({ '/auth/otp/request': { data: { requestId: 'r1' } } });
    await client.apiFetch('/auth/otp/request', { method: 'POST', body: { phone: '+234801' } });
    const auto = (calls[0].init?.headers as Record<string, string>)['Idempotency-Key'];
    expect(auto).toBeTruthy();

    await client.apiFetch('/auth/otp/request', {
      method: 'POST',
      body: { phone: '+234801' },
      idempotencyKey: 'fixed-key'
    });
    const fixed = (calls[1].init?.headers as Record<string, string>)['Idempotency-Key'];
    expect(fixed).toBe('fixed-key');
  });

  it('maps error envelopes to ApiError with the server message', async () => {
    const { client } = makeClient();
    await expect(client.apiFetch('/missing')).rejects.toThrowError(ApiError);
    await expect(client.apiFetch('/missing')).rejects.toThrowError('not found');
  });
});
