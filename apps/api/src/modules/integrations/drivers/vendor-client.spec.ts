import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderHttpError, ProviderRequestError } from './http.js';
import {
  REDACTED_VENDOR_BODY,
  VENDOR_CIRCUIT_THRESHOLD,
  VendorHttpClient,
  parseVendorTimeoutMs
} from './vendor-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A fetch that hangs until the caller aborts (drives the timeout path). */
function hangingFetch() {
  return vi.fn().mockImplementation((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    })
  );
}

function makeClient(overrides: Partial<ConstructorParameters<typeof VendorHttpClient>[0]> = {}) {
  return new VendorHttpClient({
    provider: 'test-vendor',
    baseUrl: 'https://vendor.example/',
    apiKey: 'test-key',
    retryBaseDelayMs: 1,
    ...overrides
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseVendorTimeoutMs', () => {
  it('falls back on unset, non-numeric and non-positive values', () => {
    expect(parseVendorTimeoutMs(undefined)).toBe(5000);
    expect(parseVendorTimeoutMs('')).toBe(5000);
    expect(parseVendorTimeoutMs('abc')).toBe(5000);
    expect(parseVendorTimeoutMs('0')).toBe(5000);
    expect(parseVendorTimeoutMs('-50')).toBe(5000);
  });

  it('parses a valid millisecond override', () => {
    expect(parseVendorTimeoutMs('2500')).toBe(2500);
  });
});

describe('VendorHttpClient (WP-G17)', () => {
  it('posts JSON with a bearer header and resolves the parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    const result = await client.postJson<{ ok: boolean }>('/verify', { nin: '123' });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Trailing slash on the base URL is stripped before joining.
    expect(url).toBe('https://vendor.example/verify');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-key');
    expect(headers['content-type']).toBe('application/json');
  });

  it('posts urlencoded forms', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'tok' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ apiKey: undefined });
    const result = await client.postForm<{ access_token: string }>('/token', {
      grant_type: 'password',
      username: '+2348010000001'
    });
    expect(result.access_token).toBe('tok');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['authorization']).toBeUndefined();
    expect(String(init.body)).toContain('grant_type=password');
  });

  it('times out via AbortController and raises ProviderRequestError', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const client = makeClient({ timeoutMs: 10 });
    const error = await client.postJson('/verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).reason).toBe('timeout');
  });

  it('retries transient 5xx exactly once and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'down' }, 500))
      .mockResolvedValueOnce(jsonResponse({ verified: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 1 });
    const result = await client.postJson<{ verified: boolean }>('/verify', {});
    expect(result.verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded retry on persistent 5xx', async () => {
    // Fresh Response per call: a reused body stream cannot be read twice.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ error: 'down' }, 502)));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 1 });
    const error = await client.postJson('/verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).status).toBe(502);
    // One initial attempt + one retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries 4xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 3 });
    const error = await client.postJson('/verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries transport failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hangup'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({ maxRetries: 3 });
    const error = await client.postJson('/verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts vendor response bodies from HTTP errors (PII/secrets doctrine)', async () => {
    const piiEcho = 'nin 12345678901 belongs to Amina Bello';
    const fetchMock = vi.fn().mockResolvedValue(new Response(piiEcho, { status: 422 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    const error = await client.postJson('/verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).not.toContain('12345678901');
    expect((error as Error).message).not.toContain('Amina');
    expect((error as Error).message).toContain(REDACTED_VENDOR_BODY);
  });

  it('opens the circuit after 3 consecutive failures and fails fast', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    expect(client.circuitOpen).toBe(false);
    for (let i = 0; i < VENDOR_CIRCUIT_THRESHOLD; i += 1) {
      await client.postJson('/verify', {}).catch(() => undefined);
    }
    expect(client.circuitOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // While open the call rejects without touching the network.
    const error = await client.postJson('/verify', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as Error).message).toContain('circuit open');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resets the failure counter on success', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('flap'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await client.postJson('/verify', {}).catch(() => undefined);
    await expect(client.postJson('/verify', {})).resolves.toEqual({ ok: true });
    expect(client.circuitOpen).toBe(false);
  });
});
