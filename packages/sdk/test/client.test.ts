import { describe, expect, it, vi } from 'vitest';
import {
  AgricApiError,
  AgricClient,
  LIVE_BASE_URL,
  SANDBOX_BASE_URL,
  createClient
} from '../src/index.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v
        ])
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const okEnvelope = (data: unknown) => jsonResponse({ data });

function clientWith(fetchImpl: typeof fetch, auth = { apiKey: 'ak_sandbox_test' }) {
  return new AgricClient({ auth, fetch: fetchImpl, timeoutMs: 500 });
}

describe('client setup', () => {
  it('defaults to the sandbox base URL', () => {
    const client = createClient({ auth: { apiKey: 'ak_x' }, fetch: vi.fn() as never });
    expect(client.sandbox).toBe(true);
    const live = createClient({
      auth: { apiKey: 'ak_x' },
      baseUrl: LIVE_BASE_URL,
      fetch: vi.fn() as never
    });
    expect(live.sandbox).toBe(false);
    expect(SANDBOX_BASE_URL).toContain('sandbox');
  });

  it('sends the API key header in apiKey mode', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope([]));
    await clientWith(fetchImpl).opportunities.list();
    expect(calls[0].headers['x-api-key']).toBe('ak_sandbox_test');
  });

  it('sends a bearer token in userToken mode', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope([]));
    await new AgricClient({
      auth: { userToken: 'user-jwt' },
      fetch: fetchImpl,
      timeoutMs: 500
    }).opportunities.list();
    expect(calls[0].headers['authorization']).toBe('Bearer user-jwt');
  });

  it('obtains and caches a client-credentials token', async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.url.includes('/partner/oauth/token')) {
        // The token endpoint returns the grant response un-enveloped.
        return jsonResponse({ access_token: 'm2m-token', expires_in: 900 });
      }
      return okEnvelope({ partnerId: 'p', applications: 3 });
    });
    const client = new AgricClient({
      auth: { clientId: 'pc_1', clientSecret: 'pcs_1' },
      fetch: fetchImpl,
      timeoutMs: 500
    });
    await client.partner.getImpact('p');
    await client.partner.getImpact('p');
    const tokenCalls = calls.filter((c) => c.url.includes('/partner/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'pc_1',
      client_secret: 'pcs_1'
    });
    const apiCalls = calls.filter((c) => c.url.includes('/partner/impact'));
    expect(apiCalls[0].headers['authorization']).toBe('Bearer m2m-token');
  });
});

describe('resources', () => {
  it('lists opportunities with filters as query params', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope([{ id: 'opp-1' }]));
    const result = await clientWith(fetchImpl).opportunities.list({ type: 'grant', state: 'Kano' });
    expect(result).toEqual([{ id: 'opp-1' }]);
    const url = new URL(calls[0].url);
    expect(url.pathname).toContain('/opportunities');
    expect(url.searchParams.get('type')).toBe('grant');
    expect(url.searchParams.get('state')).toBe('Kano');
  });

  it('reads the crop calendar via the advisory feed', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope([{ id: 'adv-1', kind: 'crop_calendar' }]));
    const result = await clientWith(fetchImpl).advisory.getCropCalendar({ crop: 'maize' });
    expect(result[0].kind).toBe('crop_calendar');
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('kind')).toBe('crop_calendar');
    expect(url.searchParams.get('crop')).toBe('maize');
  });

  it('looks up a consented member profile', async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      okEnvelope({ user: { id: 'user-1' }, profile: {}, enrolments: [] })
    );
    const result = await clientWith(fetchImpl).members.getProfile('user-1');
    expect(result.user).toEqual({ id: 'user-1' });
    expect(calls[0].url).toContain('/partner/members/user-1/profile');
  });

  it('creates marketplace listings with an idempotency key', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope({ id: 'lst-1' }));
    await clientWith(fetchImpl).marketplace.createListing(
      { title: 'Maize 50kg', category: 'produce', priceNgn: 42000, quantityAvailable: 10, state: 'Kano' },
      { idempotencyKey: 'fixed-key' }
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['idempotency-key']).toBe('fixed-key');
  });

  it('auto-generates idempotency keys on mutations', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope({ id: 'lst-1' }));
    await clientWith(fetchImpl).marketplace.createListing({
      title: 'x',
      category: 'produce',
      priceNgn: 1,
      quantityAvailable: 1,
      state: 'Lagos'
    });
    expect(calls[0].headers['idempotency-key']).toBeTruthy();
  });

  it('pushes farmOS-compatible farm data', async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      okEnvelope({ id: 'fd-1', userId: 'user-1', accepted: true, receivedAt: 'now' })
    );
    const result = await clientWith(fetchImpl).farm.pushFarmData({
      userId: 'user-1',
      assets: [{ type: 'asset--land', name: 'North field' }]
    });
    expect(result.accepted).toBe(true);
    expect(calls[0].url).toContain('/partner/farm-data');
    expect((calls[0].body as { assets: unknown[] }).assets).toHaveLength(1);
  });

  it('manages webhook subscriptions end to end', async () => {
    const { calls, fetchImpl } = mockFetch((call) => {
      if (call.method === 'POST') return okEnvelope({ id: 'wh-1', secret: 's3cret' });
      if (call.method === 'DELETE') return okEnvelope({ removed: true });
      return okEnvelope([{ id: 'wh-1' }]);
    });
    const client = clientWith(fetchImpl);
    const created = await client.webhooks.create({
      eventTypes: ['disbursement.recorded'],
      targetUrl: 'https://partner.example/hook',
      secret: 's3cret'
    });
    expect(created.secret).toBe('s3cret');
    expect(await client.webhooks.list()).toEqual([{ id: 'wh-1' }]);
    expect(await client.webhooks.delete('wh-1')).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'DELETE']);
  });

  it('records disbursements and enrolments', async () => {
    const { calls, fetchImpl } = mockFetch(() => okEnvelope({ id: 'evt-1' }));
    const client = clientWith(fetchImpl);
    await client.partner.recordDisbursement({
      partnerId: 'p',
      userId: 'u',
      amountNgn: 5000
    });
    await client.partner.recordEnrolment({ partnerId: 'p', userId: 'u', programmeId: 'prog-1' });
    expect(calls[0].url).toContain('/partner/disbursements');
    expect(calls[1].url).toContain('/partner/enrolments');
  });

  it('reads participation, impact and application counts', async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.includes('participation')) return okEnvelope([{ userId: 'u1', name: 'A' }]);
      if (call.url.includes('impact')) return okEnvelope({ partnerId: 'p', applications: 4 });
      return okEnvelope({ applications: 4 });
    });
    const client = clientWith(fetchImpl);
    expect(await client.partner.getParticipation('p')).toHaveLength(1);
    expect((await client.partner.getImpact('p')).applications).toBe(4);
    expect(await client.partner.getApplicationCount('p')).toBe(4);
  });
});

describe('errors and retries', () => {
  it('throws AgricApiError with the server message on 4xx without retrying', async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch(() => {
      attempts += 1;
      return jsonResponse({ message: 'Missing partner scope(s): x' }, 403);
    });
    await expect(clientWith(fetchImpl).partner.getImpact('p')).rejects.toMatchObject({
      name: 'AgricApiError',
      status: 403,
      message: 'Missing partner scope(s): x'
    });
    expect(attempts).toBe(1);
  });

  it('retries 429/5xx with exponential backoff and eventually succeeds', async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch(() => {
      attempts += 1;
      return attempts < 3 ? jsonResponse({}, 500) : okEnvelope({ partnerId: 'p' });
    });
    const client = new AgricClient({
      auth: { apiKey: 'ak' },
      fetch: fetchImpl,
      timeoutMs: 500,
      maxRetries: 3
    });
    const result = await client.partner.getImpact('p');
    expect(result.partnerId).toBe('p');
    expect(attempts).toBe(3);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch(() => {
      attempts += 1;
      return jsonResponse({}, 503);
    });
    const client = new AgricClient({
      auth: { apiKey: 'ak' },
      fetch: fetchImpl,
      timeoutMs: 500,
      maxRetries: 2
    });
    await expect(client.partner.getImpact('p')).rejects.toBeInstanceOf(AgricApiError);
    expect(attempts).toBe(3);
  });

  it('retries network failures', async () => {
    let attempts = 0;
    const { fetchImpl } = mockFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return okEnvelope([]);
    });
    const client = new AgricClient({ auth: { apiKey: 'ak' }, fetch: fetchImpl, timeoutMs: 500 });
    await expect(client.opportunities.list()).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('fails the client-credentials flow on rejected secrets', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ message: 'Invalid client credentials' }, 401));
    const client = new AgricClient({
      auth: { clientId: 'pc_bad', clientSecret: 'wrong' },
      fetch: fetchImpl,
      timeoutMs: 500
    });
    await expect(client.partner.getImpact('p')).rejects.toMatchObject({ status: 401 });
  });
});
