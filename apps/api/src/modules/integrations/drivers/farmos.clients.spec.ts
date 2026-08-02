import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFarmRecordClients,
  FarmOsClient,
  farmRecordsDriverEnabled,
  LiteFarmClient
} from './farmos.clients.js';
import { ProviderConfigError, ProviderHttpError } from './http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError'))
      );
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('FarmOsClient', () => {
  const client = () => new FarmOsClient('https://farmos.example.com', 'key-1');

  it('normalises JSON:API bundles into farm records', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/log/harvest')) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: 'log-1',
                type: 'log--harvest',
                attributes: { timestamp: '2026-03-01T10:00:00Z', quantity: 40 }
              }
            ]
          })
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = await client().fetchRecords('acct-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordType: 'harvest',
      externalId: 'log-1',
      source: 'farmos',
      observedAt: '2026-03-01T10:00:00.000Z'
    });
    // All three bundles are polled with the bearer token.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer key-1');
  });

  it('pushes member verification status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 'v-1' } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await client().pushMemberVerification('acct-1', true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://farmos.example.com/api/platform/member-verification');
    expect(JSON.parse(init.body as string).data.attributes).toEqual({
      external_account_id: 'acct-1',
      verified: true
    });
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
    await expect(client().fetchRecords('acct-1')).rejects.toThrow(ProviderHttpError);
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 502 })));
    await expect(client().pushMemberVerification('a', true)).rejects.toThrow(ProviderHttpError);
  });

  it('maps timeouts to ProviderRequestError(timeout)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const assertion = expect(client().fetchRecords('a')).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'timeout'
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('LiteFarmClient', () => {
  it('normalises known record types and skips unknown rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          records: [
            { id: 7, record_type: 'crop_plan', crop: 'Rice', updated_at: '2026-02-10T00:00:00Z' },
            { id: 8, record_type: 'expense', note: 'skip me' },
            { record_type: 'harvest' }
          ]
        })
      )
    );
    const client = new LiteFarmClient('https://litefarm.example.com', 'lf-key');
    const records = await client.fetchRecords('acct-2');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordType: 'crop_plan',
      externalId: '7',
      source: 'litefarm',
      observedAt: '2026-02-10T00:00:00.000Z'
    });
  });
});

describe('createFarmRecordClients (fail closed)', () => {
  it('returns no clients while the driver is stub', () => {
    expect(createFarmRecordClients({ FARM_RECORDS_DRIVER: 'stub' })).toEqual([]);
    expect(farmRecordsDriverEnabled({ FARM_RECORDS_DRIVER: 'stub' })).toBe(false);
  });

  it('raises ProviderConfigError when a base URL lacks its API key', () => {
    expect(() =>
      createFarmRecordClients({ FARM_RECORDS_DRIVER: 'live', FARMOS_BASE_URL: 'https://f.example' })
    ).toThrow(ProviderConfigError);
  });

  it('builds clients and enables the driver when keyed', () => {
    const env = {
      FARM_RECORDS_DRIVER: 'live',
      FARMOS_BASE_URL: 'https://f.example',
      FARMOS_API_KEY: 'k',
      LITEFARM_BASE_URL: 'https://l.example',
      LITEFARM_API_KEY: 'k2'
    };
    expect(createFarmRecordClients(env)).toHaveLength(2);
    expect(farmRecordsDriverEnabled(env)).toBe(true);
  });
});
