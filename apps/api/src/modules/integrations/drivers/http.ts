/**
 * Shared outbound HTTP plumbing for the live provider drivers (wave P1).
 * Every call uses the global fetch (Node 20+), a 5s AbortController timeout
 * and no retries — retry policy belongs to the callers. Configuration
 * problems raise ProviderConfigError (fail closed), provider responses raise
 * ProviderHttpError, and transport/timeout failures raise
 * ProviderRequestError so callers can distinguish the failure classes.
 */

export const PROVIDER_TIMEOUT_MS = 5000;

/** The driver flag demands a live provider but required env vars are absent. */
export class ProviderConfigError extends Error {
  constructor(
    readonly provider: string,
    readonly missing: readonly string[]
  ) {
    super(
      `Provider '${provider}' is enabled but missing configuration: ${missing.join(', ')}. ` +
        'Set the variables or switch the driver flag back to stub.'
    );
    this.name = 'ProviderConfigError';
  }
}

/** The provider answered with a non-2xx status. */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`Provider '${provider}' request failed with HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'ProviderHttpError';
  }
}

/** Network failure or timeout before any HTTP response. */
export class ProviderRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: 'timeout' | 'network',
    cause?: unknown
  ) {
    super(
      reason === 'timeout'
        ? `Provider '${provider}' request timed out`
        : `Provider '${provider}' request failed: ${(cause as Error)?.message ?? 'network error'}`
    );
    this.name = 'ProviderRequestError';
    this.cause = cause;
  }
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON-serialisable body. Use `form` for urlencoded payloads instead. */
  body?: unknown;
  /** application/x-www-form-urlencoded payload (takes precedence over body). */
  form?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body is empty/non-JSON. */
  json: unknown;
  text: string;
}

/**
 * Performs a single HTTP request with timeout and uniform error mapping.
 * Exported separately from httpJson so drivers that expect non-JSON
 * responses can still reuse it.
 */
export async function httpRequest(
  provider: string,
  url: string,
  options: HttpRequestOptions = {}
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  const headers: Record<string, string> = { ...options.headers };
  let body: string | undefined;
  if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    // An explicitly supplied content-type (e.g. FSPIOP vendor types for
    // Mojaloop) takes precedence over the JSON default.
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      signal: controller.signal
    });
  } catch (error) {
    const reason = controller.signal.aborted ? 'timeout' : 'network';
    throw new ProviderRequestError(provider, reason, error);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderHttpError(provider, response.status, text);
  }
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

/** Convenience wrapper that returns the parsed JSON body. */
export async function httpJson<T>(
  provider: string,
  url: string,
  options: HttpRequestOptions = {}
): Promise<T> {
  return (await httpRequest(provider, url, options)).json as T;
}

/** Reads the first present env var; throws ProviderConfigError when none is set. */
export function requireEnv(
  provider: string,
  env: NodeJS.ProcessEnv,
  names: readonly string[]
): string {
  for (const name of names) {
    const value = env[name];
    if (value) {
      return value;
    }
  }
  throw new ProviderConfigError(provider, names);
}

/** Collects the subset of `names` that are unset in `env`. */
export function missingEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter((name) => !env[name]);
}
