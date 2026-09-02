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

describe('httpRequest telemetry (Stage 25.2)', () => {
  async function withSpiedTelemetry(run: () => Promise<unknown>) {
    const { TelemetryService } = await import('../../../common/telemetry/telemetry.service.js');
    const calls = { withSpan: [] as unknown[][], increment: [] as unknown[][], record: [] as unknown[][] };
    const withSpanSpy = vi
      .spyOn(TelemetryService.prototype, 'withSpan')
      .mockImplementation(function (this: unknown, name, attrs, fn) {
        calls.withSpan.push([name, attrs]);
        return Promise.resolve(fn());
      });
    const incrementSpy = vi
      .spyOn(TelemetryService.prototype, 'increment')
      .mockImplementation((...args) => {
        calls.increment.push(args);
      });
    const recordSpy = vi
      .spyOn(TelemetryService.prototype, 'record')
      .mockImplementation((...args) => {
        calls.record.push(args);
      });
    try {
      await run();
    } finally {
      withSpanSpy.mockRestore();
      incrementSpy.mockRestore();
      recordSpy.mockRestore();
    }
    return calls;
  }

  it('wraps each call in a span with provider/method/host/path attrs (query stripped)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    const calls = await withSpiedTelemetry(() =>
      httpRequest('termii', 'https://api.termii.com/sms/send?api_key=SECRET&to=%2B234', {
        body: { a: 1 }
      })
    );
    expect(calls.withSpan[0][0]).toBe('provider.http POST');
    const attrs = calls.withSpan[0][1] as Record<string, string>;
    expect(attrs['provider.name']).toBe('termii');
    expect(attrs['http.request.method']).toBe('POST');
    expect(attrs['server.address']).toBe('api.termii.com');
    expect(attrs['url.path']).toBe('/sms/send');
    // A3-4/A3-7 doctrine: no query string, no tokens anywhere in attributes.
    expect(JSON.stringify(attrs)).not.toContain('SECRET');
    expect(JSON.stringify(attrs)).not.toContain('api_key');
    expect(JSON.stringify(attrs)).not.toContain('%2B234');
    expect(calls.record[0][0]).toBe('provider.http.duration');
    expect((calls.record[0][2] as Record<string, string>)['http.response.status_class']).toBe(
      '2xx'
    );
  });

  it('counts errors with the status class on non-2xx responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 502 })));
    const calls = await withSpiedTelemetry(() =>
      httpJson('paystack', 'https://api.paystack.co/charge').catch((e: unknown) => e)
    );
    expect(calls.increment[0][0]).toBe('provider.http.errors');
    expect(
      (calls.increment[0][2] as Record<string, string>)['http.response.status_class']
    ).toBe('5xx');
    expect(
      (calls.record[0][2] as Record<string, string>)['http.response.status_class']
    ).toBe('5xx');
  });

  it('counts transport failures with the transport class', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const calls = await withSpiedTelemetry(() =>
      httpJson('down', 'https://example.com').catch((e: unknown) => e)
    );
    expect(calls.increment[0][0]).toBe('provider.http.errors');
    expect(
      (calls.increment[0][2] as Record<string, string>)['http.response.status_class']
    ).toBe('transport');
  });

  it('omits URL attributes entirely when the URL is unparseable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('invalid URL')));
    const calls = await withSpiedTelemetry(() =>
      httpJson('x', 'not a url').catch((e: unknown) => e)
    );
    const attrs = calls.withSpan[0][1] as Record<string, string>;
    expect(attrs['server.address']).toBeUndefined();
    expect(attrs['url.path']).toBeUndefined();
  });
});
