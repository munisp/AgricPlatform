import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  httpJson,
  httpRequest,
  missingEnv,
  ProviderConfigError,
  ProviderHttpError,
  requireEnv
} from './http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpRequest', () => {
  it('returns parsed JSON on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await httpRequest('test', 'https://example.com/api', { body: { a: 1 } });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('encodes form payloads as urlencoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    await httpRequest('test', 'https://example.com/form', { form: { To: '+234', Body: 'hi there' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(init.body).toBe('To=%2B234&Body=hi+there');
  });

  it('throws ProviderHttpError on 4xx with the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('bad request', { status: 400 })))
    );
    const error = await httpJson('termii', 'https://example.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 400 });
  });

  it('throws ProviderHttpError on 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(new Response('upstream down', { status: 502 })))
    );
    await expect(httpJson('paystack', 'https://example.com')).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 502
    });
  });

  it('maps abort timeouts to ProviderRequestError(timeout)', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError'))
          );
        })
    );
    await expect(
      httpRequest('slow', 'https://example.com/hang', { timeoutMs: 20 })
    ).rejects.toMatchObject({ name: 'ProviderRequestError', reason: 'timeout' });
  });

  it('maps network failures to ProviderRequestError(network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(httpJson('down', 'https://example.com')).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'network'
    });
  });
});

describe('env helpers', () => {
  it('requireEnv returns the first set variable', () => {
    expect(requireEnv('p', { A: '', B: 'x' }, ['A', 'B'])).toBe('x');
  });

  it('requireEnv fails closed with the missing list', () => {
    expect(() => requireEnv('termii', {}, ['TERMII_API_KEY'])).toThrow(ProviderConfigError);
    expect(() => requireEnv('termii', {}, ['TERMII_API_KEY'])).toThrow(/TERMII_API_KEY/);
  });

  it('missingEnv lists unset variables only', () => {
    expect(missingEnv({ A: '1' }, ['A', 'B', 'C'])).toEqual(['B', 'C']);
  });
});
