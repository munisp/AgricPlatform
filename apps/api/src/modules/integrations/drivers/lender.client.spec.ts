import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLenderClient, LenderClient, lenderDriverEnabled } from './lender.client.js';
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

const payload = {
  memberRef: 'hash-ref',
  score: 640,
  version: 'v1',
  consentPurpose: 'lender_data_sharing',
  consentedAt: '2026-01-01T00:00:00.000Z',
  computedAt: '2026-05-01T00:00:00.000Z'
};

describe('LenderClient', () => {
  const client = () => new LenderClient('https://lender.example.com', 'lend-key');

  it('pushes the anonymised credit-readiness snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 202));
    vi.stubGlobal('fetch', fetchMock);
    await client().pushCreditReadiness(payload);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://lender.example.com/v1/credit-readiness');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer lend-key');
    expect(JSON.parse(init.body as string)).toMatchObject({ memberRef: 'hash-ref', score: 640 });
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 400 })));
    await expect(client().pushCreditReadiness(payload)).rejects.toThrow(ProviderHttpError);
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    await expect(client().pushCreditReadiness(payload)).rejects.toThrow(ProviderHttpError);
  });

  it('maps timeouts to ProviderRequestError(timeout)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const assertion = expect(client().pushCreditReadiness(payload)).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'timeout'
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('createLenderClient (fail closed)', () => {
  it('returns undefined while the driver is stub', () => {
    expect(createLenderClient({ LENDER_DRIVER: 'stub' })).toBeUndefined();
    expect(lenderDriverEnabled({ LENDER_DRIVER: 'stub' })).toBe(false);
  });

  it('raises ProviderConfigError when credentials are missing', () => {
    expect(() => createLenderClient({ LENDER_DRIVER: 'live' })).toThrow(ProviderConfigError);
  });

  it('builds and enables when fully keyed', () => {
    const env = { LENDER_DRIVER: 'production', LENDER_BASE_URL: 'https://l.example', LENDER_API_KEY: 'k' };
    expect(createLenderClient(env)).toBeInstanceOf(LenderClient);
    expect(lenderDriverEnabled(env)).toBe(true);
  });
});
