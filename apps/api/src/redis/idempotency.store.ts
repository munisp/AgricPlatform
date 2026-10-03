import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from './key-value-store.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h replay window

/** GAP-M07: distributed advisory-lock tuning for concurrent-twin serialization. */
export const IDEMPOTENCY_LOCK_TTL_MS = 30_000; // crash backstop; requests are far shorter
export const IDEMPOTENCY_LOCK_WAIT_MS = 10_000; // max time a twin waits before fail-closed 503
export const IDEMPOTENCY_LOCK_POLL_MS = 25;

/**
 * Idempotency store over the shared KeyValueStore (plan §7). Keys keep the
 * scoped `METHOD:path:key` format from Phase 1; values are JSON-serialized
 * response bodies with a 24h TTL. The Redis backend gives cross-instance
 * replay safety; the in-memory backend preserves the e2e replay semantics.
 */
export interface IdempotencyStore {
  get(scopedKey: string): Promise<unknown | undefined>;
  save(scopedKey: string, body: unknown, ttlMs?: number): Promise<void>;
  /**
   * Distributed per-key advisory lock (GAP-M07): serialises concurrent
   * FIRST requests with the same scoped key ACROSS replicas, closing the
   * check-then-act gap that per-replica locking left between instances.
   * Resolves to an idempotent, never-throwing release function. Throws when
   * the lock cannot be acquired within IDEMPOTENCY_LOCK_WAIT_MS (the caller
   * maps that to a retryable 503 — fail-closed). Optional: stores without a
   * lock primitive (minimal test doubles) fall back to the interceptor's
   * in-process chain.
   */
  acquireLock?(scopedKey: string): Promise<() => Promise<void>>;
}

export class KeyValueIdempotencyStore implements IdempotencyStore {
  constructor(private readonly kv: KeyValueStore) {}

  async get(scopedKey: string): Promise<unknown | undefined> {
    const raw = await this.kv.get(`idempotency:${scopedKey}`);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }

  async save(scopedKey: string, body: unknown, ttlMs: number = IDEMPOTENCY_TTL_MS): Promise<void> {
    // NX write: the first successful response wins the replay window.
    await this.kv.setNx(`idempotency:${scopedKey}`, JSON.stringify(body), ttlMs);
  }

  /**
   * SET NX PX spin lock over the shared KeyValueStore — distributed exactly
   * when the backend is Redis (production), per-process in the in-memory
   * backend (e2e/dev single-instance, same semantics as before). The lock
   * TTL is the crash backstop; release is token-checked so a holder whose
   * TTL lapsed cannot delete a NEWER holder's lock (the get-then-delete is
   * not atomic, but a lost race only shortens a lock that already expired
   * once — the cached envelope and service-level UNIQUE constraints remain
   * the correctness backstops).
   */
  async acquireLock(scopedKey: string): Promise<() => Promise<void>> {
    const key = `idempotency-lock:${scopedKey}`;
    const token = randomUUID();
    const deadline = Date.now() + IDEMPOTENCY_LOCK_WAIT_MS;
    for (;;) {
      if (await this.kv.setNx(key, token, IDEMPOTENCY_LOCK_TTL_MS)) {
        return async () => {
          try {
            if ((await this.kv.get(key)) === token) {
              await this.kv.delete(key);
            }
          } catch {
            // Release must never break the request path; the lock TTL is
            // the backstop when the store is unreachable.
          }
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring the idempotency lock for ${scopedKey}`);
      }
      await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_LOCK_POLL_MS));
    }
  }
}
