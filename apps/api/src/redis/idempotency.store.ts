import type { KeyValueStore } from './key-value-store.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h replay window

/**
 * Idempotency store over the shared KeyValueStore (plan §7). Keys keep the
 * scoped `METHOD:path:key` format from Phase 1; values are JSON-serialized
 * response bodies with a 24h TTL. The Redis backend gives cross-instance
 * replay safety; the in-memory backend preserves the e2e replay semantics.
 */
export interface IdempotencyStore {
  get(scopedKey: string): Promise<unknown | undefined>;
  save(scopedKey: string, body: unknown, ttlMs?: number): Promise<void>;
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
}
