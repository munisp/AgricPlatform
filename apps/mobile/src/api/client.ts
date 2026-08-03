import type { TokenStore } from './token-store';

/**
 * Typed fetch client for the NestJS API — mirrors apps/web/lib/api/client.ts
 * (envelope unwrap, error mapping, auto idempotency keys) but is constructed
 * with an explicit base URL (from app config `extra.apiBaseUrl`) and a
 * TokenStore (secure-store adapter with in-memory fallback).
 *
 * Wave A session wiring: on a 401 the client rotates the stored refresh
 * token once (POST /auth/refresh, single-flight across concurrent requests)
 * and retries the original call with the SAME idempotency key. A failed
 * rotation — including reuse-revocation of a rotated token, which revokes
 * the whole session family server-side — clears the store and notifies
 * `onSessionExpired` so the app can route back to login.
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
  /** Called once when the session is unrecoverably expired (refresh failed). */
  onSessionExpired?: () => void;
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
/** Auth endpoints must never trigger the 401 → refresh retry loop. */
const REFRESH_EXEMPT_PATHS = new Set(['/auth/refresh', '/auth/logout']);

function randomIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

interface RefreshEnvelope {
  data?: {
    user?: unknown;
    /** Present when the API also mints a new access token on rotation. */
    token?: string;
    refreshToken?: string;
    refreshTokenExpiresAt?: string;
  };
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  /** Single-flight rotation: concurrent 401s share one /auth/refresh call. */
  let refreshInFlight: Promise<boolean> | null = null;

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

  /**
   * Rotate the refresh token. Resolves true when the session was renewed,
   * false when there is nothing to rotate or rotation was rejected (the
   * store is cleared and onSessionExpired fires exactly once per failure).
   */
  async function rotateRefreshToken(): Promise<boolean> {
    const refreshToken = await options.tokenStore.getRefreshToken();
    if (!refreshToken) return false;

    let response: Response;
    try {
      response = await fetchImpl(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
    } catch {
      // Offline / network failure: keep the session, let the caller retry.
      return false;
    }

    if (!response.ok) {
      // Unknown, expired or reuse-revoked refresh token: the session family
      // is dead server-side — drop local credentials and tell the app.
      await options.tokenStore.clear();
      options.onSessionExpired?.();
      return false;
    }

    const envelope = (await response.json()) as RefreshEnvelope;
    const next = envelope.data?.refreshToken;
    if (!next) {
      await options.tokenStore.clear();
      options.onSessionExpired?.();
      return false;
    }
    await options.tokenStore.setSession({ token: envelope.data?.token, refreshToken: next });
    return true;
  }

  function refreshOnce(): Promise<boolean> {
    refreshInFlight ??= rotateRefreshToken().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function rawFetch(path: string, request: ApiRequestOptions, idempotencyKey?: string) {
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
      headers['Idempotency-Key'] = idempotencyKey ?? randomIdempotencyKey();
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
    return response;
  }

  async function parseResponse<T>(response: Response): Promise<T> {
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

  async function apiFetch<T>(path: string, request: ApiRequestOptions = {}): Promise<T> {
    const method = request.method ?? 'GET';
    // One idempotency key across the initial attempt and the post-refresh
    // retry so the API dedupes a mutation that actually went through.
    const idempotencyKey = MUTATION_METHODS.has(method)
      ? (request.idempotencyKey ?? randomIdempotencyKey())
      : undefined;

    const first = await rawFetch(path, request, idempotencyKey);
    if (first.status !== 401 || REFRESH_EXEMPT_PATHS.has(path)) {
      return parseResponse<T>(first);
    }

    // Access token rejected: rotate the refresh token once, then retry.
    const renewed = await refreshOnce();
    if (!renewed) {
      return parseResponse<T>(first);
    }
    const retry = await rawFetch(path, request, idempotencyKey);
    return parseResponse<T>(retry);
  }

  return { apiFetch, buildUrl };
}
