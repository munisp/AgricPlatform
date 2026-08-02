import type { TokenStore } from './token-store';

/**
 * Typed fetch client for the NestJS API — mirrors apps/web/lib/api/client.ts
 * (envelope unwrap, error mapping, auto idempotency keys) but is constructed
 * with an explicit base URL (from app config `extra.apiBaseUrl`) and a
 * TokenStore (secure-store adapter with in-memory fallback).
 */

export type QueryValue = string | number | boolean | undefined | null;

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface ApiClientOptions {
  /** Base URL including the /api/v1 prefix, from app config extra. */
  baseUrl: string;
  tokenStore: TokenStore;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

export interface ApiClient {
  apiFetch<T>(path: string, options?: ApiRequestOptions): Promise<T>;
  buildUrl(path: string, query?: Record<string, QueryValue>): string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Network request failed — you may be offline');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function randomIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  function buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function apiFetch<T>(path: string, request: ApiRequestOptions = {}): Promise<T> {
    const method = request.method ?? 'GET';
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';

    const token = await options.tokenStore.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (MUTATION_METHODS.has(method)) {
      headers['Idempotency-Key'] = request.idempotencyKey ?? randomIdempotencyKey();
    }

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(path, request.query), {
        method,
        headers,
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TimeoutError(timeoutMs);
      }
      throw new NetworkError(error);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      try {
        const envelope = (await response.json()) as { message?: string | string[] };
        if (typeof envelope.message === 'string') message = envelope.message;
        if (Array.isArray(envelope.message)) message = envelope.message.join('; ');
      } catch {
        // Non-JSON error body — keep the status-line message.
      }
      throw new ApiError(response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return { apiFetch, buildUrl };
}
