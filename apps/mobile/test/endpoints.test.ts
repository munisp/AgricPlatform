import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import {
  confirmDraftOrder,
  listActiveRecalls,
  listDraftOrders,
  listDueVaccinations,
  listMyAnimals,
  listMyOrders,
  listNotifications,
  logoutSession,
  markNotificationRead,
  refreshSession,
  registerAnimal
} from '../src/api/endpoints';
import { createInMemoryTokenStore } from '../src/api/token-store';

/** URL/method coverage for the Wave A endpoint wrappers. */

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function stubbed(): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  const client = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
  return { client, calls };
}

describe('Wave A endpoint wrappers', () => {
  it('listMyOrders scopes to the buyer and optional status', async () => {
    const { client, calls } = stubbed();
    await listMyOrders(client, 'user-1', 'placed');
    expect(calls[0].url).toBe('https://api.test/api/v1/orders?buyerId=user-1&status=placed');
  });

  it('listDraftOrders scopes to the buyer', async () => {
    const { client, calls } = stubbed();
    await listDraftOrders(client, 'user-1');
    expect(calls[0].url).toBe('https://api.test/api/v1/draft-orders?buyerId=user-1');
  });

  it('confirmDraftOrder posts to the confirm transition', async () => {
    const { client, calls } = stubbed();
    await confirmDraftOrder(client, 'draft-1');
    expect(calls[0].url).toBe('https://api.test/api/v1/draft-orders/draft-1/confirm');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('listNotifications scopes to the user', async () => {
    const { client, calls } = stubbed();
    await listNotifications(client, 'user-9');
    expect(calls[0].url).toBe('https://api.test/api/v1/notifications?userId=user-9');
  });

  it('markNotificationRead posts to the read transition', async () => {
    const { client, calls } = stubbed();
    await markNotificationRead(client, 'n-1');
    expect(calls[0].url).toBe('https://api.test/api/v1/notifications/n-1/read');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('listMyAnimals hits the registry mine endpoint', async () => {
    const { client, calls } = stubbed();
    await listMyAnimals(client);
    expect(calls[0].url).toBe('https://api.test/api/v1/livestock/animals/mine');
  });

  it('registerAnimal posts the registration payload', async () => {
    const { client, calls } = stubbed();
    await registerAnimal(client, { species: 'goat', breed: 'Sahel', sex: 'female', state: 'Kano' });
    expect(calls[0].url).toBe('https://api.test/api/v1/livestock/animals');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ species: 'goat', state: 'Kano' });
  });

  it('listActiveRecalls filters to active recalls', async () => {
    const { client, calls } = stubbed();
    await listActiveRecalls(client);
    expect(calls[0].url).toBe('https://api.test/api/v1/livestock-health/recalls?status=active');
  });

  it('listDueVaccinations defaults to a 30-day lookahead window', async () => {
    const { client, calls } = stubbed();
    await listDueVaccinations(client);
    expect(calls[0].url).toBe('https://api.test/api/v1/livestock-health/vaccinations/due?days=30');
  });

  it('listDueVaccinations passes an explicit window', async () => {
    const { client, calls } = stubbed();
    await listDueVaccinations(client, 90);
    expect(calls[0].url).toBe('https://api.test/api/v1/livestock-health/vaccinations/due?days=90');
  });

  it('refreshSession posts the presented refresh token', async () => {
    const { client, calls } = stubbed();
    await refreshSession(client, 'refresh-1');
    expect(calls[0].url).toBe('https://api.test/api/v1/auth/refresh');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ refreshToken: 'refresh-1' });
  });

  it('logoutSession posts the refresh token for revocation', async () => {
    const { client, calls } = stubbed();
    await logoutSession(client, 'refresh-1');
    expect(calls[0].url).toBe('https://api.test/api/v1/auth/logout');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ refreshToken: 'refresh-1' });
  });
});
