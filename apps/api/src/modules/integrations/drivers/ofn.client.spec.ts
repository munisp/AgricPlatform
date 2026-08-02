import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfnClient, OfnClient, ofnDriverEnabled } from './ofn.client.js';
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

const listing = { name: 'Maize 50kg', price: 42000, sku: 'listing-1' };

describe('OfnClient', () => {
  const client = () => new OfnClient('https://ofn.example.com', 'spree-token', 'ent-1');

  it('pushes a listing with the Spree token header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 501 }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const result = await client().pushListing(listing);
    expect(result.productId).toBe('501');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ofn.example.com/api/v0/products');
    expect((init.headers as Record<string, string>)['X-Spree-Token']).toBe('spree-token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'Maize 50kg',
      sku: 'listing-1',
      supplier_id: 'ent-1'
    });
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 422 })));
    await expect(client().pushListing(listing)).rejects.toThrow(ProviderHttpError);
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 503 })));
    await expect(client().pushListing(listing)).rejects.toThrow(ProviderHttpError);
  });

  it('maps timeouts to ProviderRequestError(timeout)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const assertion = expect(client().pushListing(listing)).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'timeout'
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('createOfnClient (fail closed)', () => {
  it('returns undefined while the driver is stub', () => {
    expect(createOfnClient({ OFN_DRIVER: 'stub' })).toBeUndefined();
    expect(ofnDriverEnabled({ OFN_DRIVER: 'stub' })).toBe(false);
  });

  it('raises ProviderConfigError when credentials are missing', () => {
    expect(() => createOfnClient({ OFN_DRIVER: 'live', OFN_BASE_URL: 'https://o.example' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds and enables when fully keyed', () => {
    const env = {
      OFN_DRIVER: 'sandbox',
      OFN_BASE_URL: 'https://o.example',
      OFN_API_KEY: 'k',
      OFN_ENTERPRISE_ID: 'e1'
    };
    expect(createOfnClient(env)).toBeInstanceOf(OfnClient);
    expect(ofnDriverEnabled(env)).toBe(true);
  });
});
