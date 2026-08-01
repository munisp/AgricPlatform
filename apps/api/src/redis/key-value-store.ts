import type { Redis } from 'ioredis';

/**
 * Minimal key-value contract for the idempotency and OTP stores (plan §7).
 * Implementations: InMemoryKeyValueStore (TTL sweep, preserves the Phase 1
 * semantics exactly) and RedisKeyValueStore (SET … PX … NX / GETDEL).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Atomic set-if-absent; returns true when the value was stored. */
  setNx(key: string, value: string, ttlMs?: number): Promise<boolean>;
  /** Atomic read-and-delete (single-use values). */
  getdel(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
}

interface MemoryEntry {
  value: string;
  expiresAt?: number;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
    });
  }

  async setNx(key: string, value: string, ttlMs?: number): Promise<boolean> {
    if ((await this.get(key)) !== undefined) {
      return false;
    }
    await this.set(key, value, ttlMs);
    return true;
  }

  async getdel(key: string): Promise<string | undefined> {
    const value = await this.get(key);
    this.entries.delete(key);
    return value;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.redis.get(key)) ?? undefined;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      await this.redis.set(key, value, 'PX', ttlMs);
    } else {
      await this.redis.set(key, value);
    }
  }

  async setNx(key: string, value: string, ttlMs?: number): Promise<boolean> {
    const result =
      ttlMs !== undefined
        ? await this.redis.set(key, value, 'PX', ttlMs, 'NX')
        : await this.redis.set(key, value, 'NX');
    return result === 'OK';
  }

  async getdel(key: string): Promise<string | undefined> {
    return (await this.redis.getdel(key)) ?? undefined;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
