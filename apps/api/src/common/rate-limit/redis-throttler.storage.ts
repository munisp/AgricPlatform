import type { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import { Logger } from '@nestjs/common';
import type { MetricsService } from '../metrics/metrics.service.js';

/**
 * Redis-backed throttler storage (Wave P). Replaces the default in-memory
 * store when REDIS_URL is configured so rate limits hold across API
 * replicas (docs/production-readiness.md). Uses plain INCR + PEXPIRE —
 * atomic enough for fixed-window limiting without Lua.
 *
 * Behaviour: identical fixed-window semantics to the built-in
 * ThrottlerStorageService; when REDIS_URL is absent the app keeps the
 * in-memory store (single-instance only, as before).
 *
 * Degraded tier (V-77): the rate-limit cache is a CACHE, not a store of
 * record. A Redis error therefore FAILS OPEN — the request is served
 * unthrottled — with agric_throttle_redis_errors_total incremented and an
 * error log per failure, so the outage is loud in metrics while reads and
 * mutations keep flowing. Contrast: the idempotency/OTP paths use Redis as
 * a store of record and stay FAIL-CLOSED (503) — see
 * common/interceptors/idempotency.interceptor.ts. The readiness probe
 * (/health/ready) distinguishes the two tiers.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(
    private readonly redis: Redis,
    private readonly metrics?: MetricsService
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.incrementStrict(key, ttl, limit, blockDuration, throttlerName);
    } catch (error) {
      // Fail OPEN (V-77): a throttler-cache outage must not take down the
      // whole API. The request proceeds unthrottled; the metric + log make
      // the protection loss visible (alert: rate > 0 ⇒ rate limiting is
      // effectively off until Redis recovers).
      this.metrics?.throttleRedisError();
      this.logger.error(
        `Redis throttler storage failed (${error instanceof Error ? error.message : String(error)}) — serving unthrottled`
      );
      return { totalHits: 1, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  private async incrementStrict(
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
