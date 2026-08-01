import { RateLimitError } from './errors';

export interface BackoffOptions {
  /** Maximum number of attempts (including the first). Default 3. */
  attempts?: number;
  /** Base delay in ms for exponential backoff (attempt n waits base * 2^(n-1)). */
  baseDelayMs?: number;
  /** Optional sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry helper that respects 429 throttling: waits for the server-provided
 * Retry-After (when present) or an exponential backoff, then retries. All
 * other errors are rethrown immediately.
 */
export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  options: BackoffOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!(error instanceof RateLimitError) || attempt === attempts) {
        throw error;
      }
      const waitMs =
        error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1_000
          : baseDelayMs * 2 ** (attempt - 1);
      await sleep(waitMs);
    }
  }
  throw lastError;
}
