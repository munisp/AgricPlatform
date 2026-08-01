import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, setAuthProvider } from '@/lib/api/client';
import {
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  UnauthorizedError
} from '@/lib/api/errors';
import { withRateLimitBackoff } from '@/lib/api/backoff';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
}

function errorEnvelope(statusCode: number, message = 'boom') {
  return {
    statusCode,
    error: 'Error',
    message,
    path: '/api/v1/test',
    timestamp: new Date().toISOString()
  };
}

describe('apiFetch', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    setAuthProvider(() => null);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('unwraps the { data } success envelope for items', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'user-1', fullName: 'Ada' } }));
    const result = await apiFetch<{ data: { id: string } }>('/users/user-1');
    expect(result.data.id).toBe('user-1');
  });

  it('returns the full pagination envelope for lists', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'a' }], total: 1, page: 1, pageSize: 20 })
    );
    const result = await apiFetch<{ data: unknown[]; total: number }>('/opportunities');
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
  });

  it('serialises query params and drops empty values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await apiFetch('/listings', { query: { state: 'Kano', q: undefined, page: 2 } });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('state')).toBe('Kano');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('q')).toBe(false);
  });

  it('adds an Idempotency-Key header to mutations but not to GETs', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ data: {} }));
    await apiFetch('/listings', { method: 'POST', body: { title: 'x' } });
    const postHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(postHeaders['Idempotency-Key']).toMatch(/.+/);

    await apiFetch('/listings');
    const getHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(getHeaders['Idempotency-Key']).toBeUndefined();
  });

  it('reuses a caller-provided idempotency key (offline queue replay)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await apiFetch('/orders', { method: 'POST', body: {}, idempotencyKey: 'fixed-key-1' });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('fixed-key-1');
  });

  it('prefers Bearer token over the dev x-user-id header', async () => {
    setAuthProvider(() => ({ token: 'jwt-token', userId: 'user-adamu' }));
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await apiFetch('/dashboard/user-adamu');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-token');
    expect(headers['x-user-id']).toBeUndefined();
  });

  it('sends x-user-id in development when no token exists', async () => {
    setAuthProvider(() => ({ userId: 'user-adamu' }));
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await apiFetch('/dashboard/user-adamu');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-user-id']).toBe('user-adamu');
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps 401/403/404/500 envelopes to typed errors', async () => {
    const cases: Array<[number, unknown]> = [
      [401, UnauthorizedError],
      [403, ForbiddenError],
      [404, NotFoundError],
      [500, ServerError]
    ];
    for (const [status, klass] of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse(errorEnvelope(status), { status }));
      await expect(apiFetch('/x')).rejects.toBeInstanceOf(klass as new (...args: never[]) => Error);
    }
  });

  it('maps 429 to RateLimitError with Retry-After seconds', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(errorEnvelope(429, 'Throttled'), { status: 429, headers: { 'Retry-After': '7' } })
    );
    const promise = apiFetch('/x');
    await expect(promise).rejects.toBeInstanceOf(RateLimitError);
    await promise.catch((error: unknown) => {
      expect((error as RateLimitError).retryAfterSeconds).toBe(7);
    });
  });

  it('throws NetworkError when fetch fails (offline / unreachable)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(apiFetch('/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws TimeoutError when the request exceeds the timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    await expect(apiFetch('/slow', { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('withRateLimitBackoff', () => {
  it('retries 429s honouring Retry-After and succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const envelope = errorEnvelope(429, 'Throttled');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError(envelope, 1))
      .mockResolvedValue('ok');
    const result = await withRateLimitBackoff(fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not retry non-429 errors', async () => {
    const fn = vi.fn().mockRejectedValue(new ServerError(errorEnvelope(500)));
    await expect(withRateLimitBackoff(fn, { sleep: vi.fn() })).rejects.toBeInstanceOf(ServerError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
