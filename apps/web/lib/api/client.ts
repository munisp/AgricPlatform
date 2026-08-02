import { API_BASE_URL, DEFAULT_TIMEOUT_MS } from './config';
import {
  NetworkError,
  TimeoutError,
  isApiErrorEnvelope,
  toApiError
} from './errors';

/**
 * Identity used to authenticate API requests. Production clients send
 * `Authorization: Bearer <OIDC JWT>`; development may send `x-user-id`
 * (honoured by the API only when NODE_ENV !== 'production').
 */
export interface AuthIdentity {
  userId?: string;
  token?: string;
}

type AuthProvider = () => AuthIdentity | null;

let authProvider: AuthProvider = () => null;

/**
 * Registered by the session provider so every request (including offline
 * queue flushes) carries the current identity. Never invents tokens.
 */
export function setAuthProvider(provider: AuthProvider): void {
  authProvider = provider;
}

/** Current auth identity (used by binary download helpers outside apiFetch). */
export function getAuthIdentity(): AuthIdentity | null {
  return authProvider();
}

/** Absolute API URL for a path + query (shared with download helpers). */
export function apiUrl(path: string, query?: Record<string, QueryValue>): string {
  return buildUrl(path, query);
}

export type QueryValue = string | number | boolean | undefined | null;

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body for mutations. */
  body?: unknown;
  /** Query string parameters; undefined/null values are dropped. */
  query?: Record<string, QueryValue>;
  /**
   * Idempotency key for mutations. POST/PUT/PATCH requests get one
   * automatically (crypto.randomUUID) unless explicitly provided — the
   * offline queue reuses the stored key so retries replay safely.
   */
  idempotencyKey?: string;
  /** Override the default ~10s timeout. */
  timeoutMs?: number;
  /** External abort signal (combined with the timeout signal). */
  signal?: AbortSignal;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function randomIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // jsdom / very old browsers fallback — still unique per call.
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Typed fetch client for the NestJS API.
 *
 * - Unwraps the `{ data: … }` success envelope (list envelopes
 *   `{ data, total, page, pageSize }` are returned whole).
 * - Maps the error envelope to typed errors (401/403/404/429/5xx).
 * - Attaches auth headers from the registered session provider.
 * - Adds an `Idempotency-Key` header to every mutation automatically.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);
  const removeExternalListener =
    options.signal != null
      ? (() => {
          const onAbort = () => controller.abort(options.signal!.reason);
          if (options.signal!.aborted) {
            onAbort();
            return undefined;
          }
          options.signal!.addEventListener('abort', onAbort);
          return () => options.signal!.removeEventListener('abort', onAbort);
        })()
      : undefined;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const identity = authProvider();
  if (identity?.token) {
    headers.Authorization = `Bearer ${identity.token}`;
  } else if (identity?.userId) {
    // Development stub — ignored by the API in production.
    headers['x-user-id'] = identity.userId;
  }

  if (MUTATION_METHODS.has(method)) {
    headers['Idempotency-Key'] = options.idempotencyKey ?? randomIdempotencyKey();
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof TimeoutError) throw error;
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TimeoutError(timeoutMs);
    }
    throw new NetworkError(error);
  } finally {
    clearTimeout(timeout);
    removeExternalListener?.();
  }

  if (!response.ok) {
    let envelope: unknown = null;
    try {
      envelope = await response.json();
    } catch {
      // Non-JSON error body (proxy HTML page, empty 502, …)
    }
    if (isApiErrorEnvelope(envelope)) {
      throw toApiError(envelope, parseRetryAfter(response.headers.get('retry-after')));
    }
    throw toApiError(
      {
        statusCode: response.status,
        error: response.statusText || 'HTTP Error',
        message: `Request failed with status ${response.status}`,
        path,
        timestamp: new Date().toISOString()
      },
      parseRetryAfter(response.headers.get('retry-after'))
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json()) as unknown;
  // Success envelope unwrap: single items are `{ data: T }`; paginated lists
  // are `{ data: T[], total, page, pageSize }` and are returned whole.
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload as T;
  }
  return payload as T;
}
