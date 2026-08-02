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
  'token'
]);

/**
 * Best-effort deep scrub of secrets/PII from a Sentry event before it leaves
 * the process (observability plan §A.4): auth headers, phone numbers, OTP
 * fields, tokens. Nested objects and arrays are walked; unknown shapes are
 * left untouched.
 */
export function scrubSentryEvent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSentryEvent(item, depth + 1)) as T;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    out[key] = SCRUB_KEYS.has(key.toLowerCase()) ? '[redacted]' : scrubSentryEvent(entry, depth + 1);
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
