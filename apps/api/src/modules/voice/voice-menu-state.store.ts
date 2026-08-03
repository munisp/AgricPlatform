import type { Redis } from 'ioredis';
import type { UssdAgronomyState } from './ussd-agronomy.js';

/**
 * Voice menu-state store (wave VOICE). Holds the ephemeral USSD menu-engine
 * state between callbacks. REDIS_URL-gated, mirroring the redis-throttler
 * approach: when the global RedisModule resolved a client (REDIS_URL set)
 * the store is shared across API replicas; otherwise an in-memory map with
 * TTL preserves single-instance semantics. Interface-first so tests can
 * inject either driver.
 */

export interface VoiceMenuStateStore {
  readonly name: 'memory' | 'redis';
  get(sessionId: string): Promise<UssdAgronomyState | undefined>;
  set(sessionId: string, state: UssdAgronomyState, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

interface MemoryEntry {
  state: UssdAgronomyState;
  expiresAt: number;
}

export class InMemoryVoiceMenuStateStore implements VoiceMenuStateStore {
  readonly name = 'memory' as const;
  private readonly entries = new Map<string, MemoryEntry>();

  get(sessionId: string): Promise<UssdAgronomyState | undefined> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(sessionId);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(structuredClone(entry.state));
  }

  set(sessionId: string, state: UssdAgronomyState, ttlMs: number): Promise<void> {
    this.entries.set(sessionId, {
      state: structuredClone(state),
      expiresAt: Date.now() + ttlMs
    });
    return Promise.resolve();
  }

  delete(sessionId: string): Promise<void> {
    this.entries.delete(sessionId);
    return Promise.resolve();
  }
}

const KEY_PREFIX = 'voice:menu:';

export class RedisVoiceMenuStateStore implements VoiceMenuStateStore {
  readonly name = 'redis' as const;

  constructor(private readonly redis: Redis) {}

  async get(sessionId: string): Promise<UssdAgronomyState | undefined> {
    const raw = await this.redis.get(`${KEY_PREFIX}${sessionId}`);
    return raw ? (JSON.parse(raw) as UssdAgronomyState) : undefined;
  }

  async set(sessionId: string, state: UssdAgronomyState, ttlMs: number): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}${sessionId}`, JSON.stringify(state), 'PX', ttlMs);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}${sessionId}`);
  }
}

/** Picks the Redis driver when a client is available, else in-memory. */
export function createVoiceMenuStateStore(redis: Redis | null): VoiceMenuStateStore {
  return redis ? new RedisVoiceMenuStateStore(redis) : new InMemoryVoiceMenuStateStore();
}
