/**
 * Shared resilient HTTP client for live vendor integrations (Stage 27,
 * WP-G16/G17): phone-auth Keycloak token issuance, the NIN identity vendor
 * and the agent-banking OTP vendor.
 *
 * Per platform pattern (mojaloop / tigerbeetle drivers) every client gets:
 * - an AbortController timeout per attempt (default 5s, env-configurable),
 *   provided by the shared provider HTTP plumbing (./http.js);
 * - a call-time circuit breaker: 3 consecutive failures open the circuit
 *   for 30s and calls fail fast while it is open;
 * - a bounded retry (default: ONE retry) with full-jitter backoff, applied
 *   ONLY to transient 5xx responses — 4xx and transport/timeout failures
 *   are never retried.
 *
 * REDACTION DOCTRINE: vendor request/response bodies may carry PII (NIN,
 * phone numbers, OTP codes) or secrets. They are NEVER included in thrown
 * errors — ProviderHttpError bodies are replaced with a fixed redaction
 * label before the error can travel to logs or exception mappers.
 */

import {
  httpRequest,
  PROVIDER_TIMEOUT_MS,
  ProviderHttpError,
  ProviderRequestError
} from './http.js';

export const VENDOR_CIRCUIT_THRESHOLD = 3;
export const VENDOR_CIRCUIT_COOLDOWN_MS = 30_000;
export const VENDOR_RETRY_BASE_DELAY_MS = 100;

/** Fixed replacement for vendor response bodies in errors (PII/secrets). */
export const REDACTED_VENDOR_BODY =
  '[redacted: vendor response bodies may contain PII or secrets]';

export interface VendorClientConfig {
  /** Low-cardinality provider label for errors/telemetry (never a URL). */
  provider: string;
  /** Vendor base URL; the path passed to post* is appended. */
  baseUrl: string;
  /** Optional bearer credential. Sent as a header, never logged. */
  apiKey?: string;
  /** Per-attempt timeout in ms (default PROVIDER_TIMEOUT_MS = 5000). */
  timeoutMs?: number;
  /** Bounded retries for transient 5xx (default 1 = one retry). */
  maxRetries?: number;
  /** Base for the full-jitter backoff in ms (default 100). */
  retryBaseDelayMs?: number;
}

/** Parses an env-provided timeout; falls back when unset/invalid. */
export function parseVendorTimeoutMs(
  raw: string | undefined,
  fallback = PROVIDER_TIMEOUT_MS
): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VendorHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly config: VendorClientConfig) {
    // Strip trailing slashes without a regex so URL joining is predictable.
    let base = config.baseUrl.trim();
    while (base.endsWith('/')) {
      base = base.slice(0, -1);
    }
    this.baseUrl = base;
    this.timeoutMs = config.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? 1;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? VENDOR_RETRY_BASE_DELAY_MS;
  }

  /** Visible for tests/status: whether the circuit breaker is open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= VENDOR_CIRCUIT_THRESHOLD && Date.now() < this.circuitOpenUntil
    );
  }

  /** POST a JSON body; resolves with the parsed JSON response body. */
  postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { body });
  }

  /** POST an application/x-www-form-urlencoded form; resolves parsed JSON. */
  postForm<T>(path: string, form: Record<string, string>): Promise<T> {
    return this.request<T>(path, { form });
  }

  private async request<T>(
    path: string,
    payload: { body?: unknown; form?: Record<string, string> }
  ): Promise<T> {
    this.assertCircuitClosed();
    try {
      const result = await this.withRetry(() => this.attempt<T>(path, payload));
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private async attempt<T>(
    path: string,
    payload: { body?: unknown; form?: Record<string, string> }
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.config.apiKey) {
      headers['authorization'] = `Bearer ${this.config.apiKey}`;
    }
    try {
      const response = await httpRequest(this.config.provider, this.url(path), {
        method: 'POST',
        headers,
        timeoutMs: this.timeoutMs,
        ...(payload.body !== undefined ? { body: payload.body } : {}),
        ...(payload.form ? { form: payload.form } : {})
      });
      return response.json as T;
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        // REDACTION: never propagate the vendor response body — it may echo
        // the NIN/phone/OTP we sent or carry vendor secrets.
        throw new ProviderHttpError(error.provider, error.status, REDACTED_VENDOR_BODY);
      }
      throw error;
    }
  }

  /** Bounded retry with full-jitter backoff — transient 5xx ONLY. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelayMs(attempt));
      }
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const transient = error instanceof ProviderHttpError && error.status >= 500;
        if (!transient) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /** Full jitter: uniform in [0, base * 2^(attempt-1)) — attempt is 1-based. */
  private retryDelayMs(attempt: number): number {
    return Math.floor(Math.random() * this.retryBaseDelayMs * 2 ** (attempt - 1));
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        this.config.provider,
        'network',
        new Error(
          `circuit open after ${this.consecutiveFailures} consecutive failures; retry after cooldown`
        )
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= VENDOR_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + VENDOR_CIRCUIT_COOLDOWN_MS;
    }
  }
}
