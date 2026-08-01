/**
 * Typed errors mirroring the API error envelope:
 * `{ statusCode, error, message, path, timestamp }` (see
 * apps/api/src/common/filters/api-exception.filter.ts).
 */
export interface ApiErrorEnvelope {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly error: string;
  readonly path: string;
  readonly timestamp: string;

  constructor(envelope: ApiErrorEnvelope) {
    const message = Array.isArray(envelope.message)
      ? envelope.message.join('; ')
      : envelope.message;
    super(message);
    this.name = 'ApiError';
    this.statusCode = envelope.statusCode;
    this.error = envelope.error;
    this.path = envelope.path;
    this.timestamp = envelope.timestamp;
  }
}

/** 401 — the user must sign in (no/invalid bearer token or dev header). */
export class UnauthorizedError extends ApiError {
  readonly name = 'UnauthorizedError';
}

/** 403 — authenticated but not allowed (RBAC role gate or owner-or-admin). */
export class ForbiddenError extends ApiError {
  readonly name = 'ForbiddenError';
}

/** 404 — resource does not exist. */
export class NotFoundError extends ApiError {
  readonly name = 'NotFoundError';
}

/** 400/422 — the server rejected the payload. */
export class ValidationError extends ApiError {
  readonly name = 'ValidationError';
}

/** 429 — throttled. `retryAfterSeconds` comes from the Retry-After header. */
export class RateLimitError extends ApiError {
  readonly name = 'RateLimitError';
  readonly retryAfterSeconds?: number;

  constructor(envelope: ApiErrorEnvelope, retryAfterSeconds?: number) {
    super(envelope);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 5xx — the API itself failed. */
export class ServerError extends ApiError {
  readonly name = 'ServerError';
}

/** Fetch could not complete: DNS, connection refused, CORS, offline… */
export class NetworkError extends Error {
  readonly name = 'NetworkError';

  constructor(cause: unknown) {
    super('The API is unreachable. You may be offline — changes are queued and will sync later.');
    this.cause = cause;
  }
}

/** The request exceeded the client-side timeout. */
export class TimeoutError extends Error {
  readonly name = 'TimeoutError';

  constructor(timeoutMs: number) {
    super(`The API did not respond within ${Math.round(timeoutMs / 1000)}s.`);
  }
}

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.statusCode === 'number' &&
    typeof record.error === 'string' &&
    (typeof record.message === 'string' || Array.isArray(record.message))
  );
}

/** Map an error envelope + status to the most specific typed error. */
export function toApiError(
  envelope: ApiErrorEnvelope,
  retryAfterSeconds?: number
): ApiError {
  switch (envelope.statusCode) {
    case 401:
      return new UnauthorizedError(envelope);
    case 403:
      return new ForbiddenError(envelope);
    case 404:
      return new NotFoundError(envelope);
    case 429:
      return new RateLimitError(envelope, retryAfterSeconds);
    default:
      if (envelope.statusCode >= 500) return new ServerError(envelope);
      if (envelope.statusCode === 400 || envelope.statusCode === 422) {
        return new ValidationError(envelope);
      }
      return new ApiError(envelope);
  }
}
