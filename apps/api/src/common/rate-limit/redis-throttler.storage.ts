import type { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';

/**
 * Redis-backed throttler storage (Wave P). Replaces the default in-memory
 * store when REDIS_URL is configured so rate limits hold across API
 * replicas (docs/production-readiness.md). Uses plain INCR + PEXPIRE —
 * atomic enough for fixed-window limiting without Lua.
 *
 * Behaviour: identical fixed-window semantics to the built-in
 * ThrottlerStorageService; when REDIS_URL is absent the app keeps the
 * in-memory store (single-instance only, as before).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    const namespaced = `throttle:${throttlerName}:${key}`;
    const totalHits = await this.redis.incr(namespaced);
    if (totalHits === 1) {
      await this.redis.pexpire(namespaced, ttl);
    }
    let timeToExpire = await this.redis.pttl(namespaced);
    if (timeToExpire < 0) {
      // Key lost its TTL race (expired between INCR and PTTL): reset the window.
      await this.redis.pexpire(namespaced, ttl);
      timeToExpire = ttl;
    }

    const blockKey = `${namespaced}:blocked`;
    let isBlocked = false;
    let timeToBlockExpire = 0;
    if (totalHits > limit && blockDuration > 0) {
      // Set the block marker once; its TTL is the remaining block time.
      const set = await this.redis.set(blockKey, '1', 'PX', blockDuration, 'NX');
      if (set !== null) {
        isBlocked = true;
        timeToBlockExpire = blockDuration;
      }
    }
    const blockTtl = await this.redis.pttl(blockKey);
    if (blockTtl > 0) {
      isBlocked = true;
      timeToBlockExpire = blockTtl;
    }

    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire };
  }
}
