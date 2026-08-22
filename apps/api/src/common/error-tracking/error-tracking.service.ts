import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

type SentryClient = {
  captureException: (error: unknown, hint?: unknown) => string;
};

const SCRUB_KEYS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'phone',
  'code',
  'devcode',
  'token',
  // Audit A3-9: newer credential fields that previously leaked through.
  'x-at-callback-token',
  'verif-hash',
  'x-webhook-signature',
  'x-paystack-signature',
  'secret',
  'password',
  'apikey',
  'api-key',
  'nin'
]);

/**
 * Best-effort scrub of credential material embedded in free-text strings
 * (audit A3-9): exception message strings — e.g. ProviderHttpError bodies,
 * which may echo request credentials — pass through object-key filtering
 * untouched, so `key=value` / `key: value` / `?token=...` fragments naming
 * a scrub key are redacted inside the string itself.
 */
/**
 * Best-effort scrub of credential material embedded in free-text strings
 * (audit A3-9): exception message strings — e.g. ProviderHttpError bodies,
 * which may echo request credentials — pass through object-key filtering
 * untouched, so `key=value` / `key: value` / `?token=...` fragments naming
 * a scrub key are redacted inside the string itself. JSON-quoted pairs
 * ("token":"...") are redacted wholesale so spaced/quoted values cannot
 * leak past a bare-value pattern.
 */
const SCRUB_KEY_NAMES =
  'authorization|cookie|x-api-key|api[-_]?key|phone|devcode|token|x-at-callback-token|verif-hash|x-webhook-signature|x-paystack-signature|secret|password|nin';
const SCRUB_JSON_PAIR_PATTERN = new RegExp(
  `("(?:${SCRUB_KEY_NAMES})"\\s*:\\s*")([^"]*)(")`,
  'gi'
);
const SCRUB_BARE_PAIR_PATTERN = new RegExp(
  `\\b(${SCRUB_KEY_NAMES})\\b(\\s*[=:]\\s*["']?)([^\\s&"']+)`,
  'gi'
);

function scrubString(value: string): string {
  return value
    .replace(SCRUB_JSON_PAIR_PATTERN, '$1[redacted]$3')
    .replace(SCRUB_BARE_PAIR_PATTERN, '$1$2[redacted]');
}

/**
 * Key fragments that mark a field as credential-bearing even under a
 * compound name (signingSecret, apiKey, csrfToken, ninHash, ...). Exact
 * matching alone misses these (audit A3-9).
 */
const SCRUB_KEY_FRAGMENTS = [
  'secret',
  'password',
  'token',
  'apikey',
  'api-key',
  'api_key',
  'verif-hash',
  'signature',
  'nin'
];

function isScrubKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SCRUB_KEYS.has(lower) || SCRUB_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Best-effort deep scrub of secrets/PII from a Sentry event before it leaves
 * the process (observability plan §A.4): auth headers, phone numbers, OTP
 * fields, tokens. Nested objects and arrays are walked; string values are
 * pattern-scrubbed; unknown shapes are left untouched.
 */
export function scrubSentryEvent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return scrubString(value) as T;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSentryEvent(item, depth + 1)) as T;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    out[key] = isScrubKey(key) ? '[redacted]' : scrubSentryEvent(entry, depth + 1);
  }
  return out as T;
}

/**
 * Error tracking behind Sentry (observability plan §A.4). Fully disabled
 * unless SENTRY_DSN is set: the `@sentry/nestjs` SDK is loaded via dynamic
 * import only when a DSN exists, so the dependency never affects boot time,
 * bundle, or behavior in environments without error tracking.
 */
@Injectable()
export class ErrorTrackingService implements OnModuleInit {
  private readonly logger = new Logger(ErrorTrackingService.name);
  private sentry: SentryClient | null = null;

  get enabled(): boolean {
    return this.sentry !== null;
  }

  async onModuleInit(): Promise<void> {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
      return; // no DSN -> fully disabled
    }
    try {
      const sentry = (await import('@sentry/nestjs')) as unknown as {
        init: (options: Record<string, unknown>) => void;
      } & SentryClient;
      sentry.init({
        dsn,
        environment: process.env.NODE_ENV ?? 'development',
        tracesSampleRate: 0,
        beforeSend: (event: unknown) => scrubSentryEvent(event)
      });
      this.sentry = sentry;
      this.logger.log('Sentry error tracking enabled');
    } catch (error) {
      // Error tracking must never take the API down.
      this.logger.warn(`Sentry init failed; error tracking disabled: ${(error as Error).message}`);
    }
  }

  /** Captures server errors (status >= 500) only; 4xx is client noise. */
  capture5xx(error: unknown, context: { status: number; requestId?: string; path?: string }): void {
    if (!this.sentry || context.status < 500) {
      return;
    }
    try {
      this.sentry.captureException(error, {
        tags: { requestId: context.requestId, path: context.path }
      });
    } catch {
      // swallow: reporting must never break the error path
    }
  }
}
