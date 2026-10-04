import type { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import { Logger } from '@nestjs/common';
import type { MetricsService } from '../metrics/metrics.service.js';

/**
 * Redis-backed throttler storage (Wave P). Replaces the default in-memory
 * store when REDIS_URL is configured so rate limits hold across API
 * replicas (docs/production-readiness.md). Uses INCR + PEXPIRE + PTTL in a
 * single pipelined round trip (perf P3-11) — atomic enough for
 * fixed-window limiting without Lua.
 *
 * Behaviour: identical fixed-window semantics to the built-in
 * ThrottlerStorageService; when REDIS_URL is absent the app keeps the
 * in-memory store (single-instance only, as before).
 *
 * Degraded tier (V-77, hardened GAP-M06): the rate-limit cache is a CACHE,
 * not a store of record, so a Redis error must NOT take the API down — but
 * failing OPEN (serving unthrottled) left the platform without any rate
 * limiting during exactly the kind of incident that attracts abuse. The
 * storage therefore CIRCUITS TO A SAFE DEFAULT: a conservative per-replica
 * in-process fixed-window counter (same key/limit/ttl semantics) keeps the
 * throttle engaged — at per-replica granularity, i.e. the effective budget
 * is limit × replica count — with agric_throttle_redis_errors_total
 * incremented and an error log per failure so the degradation stays loud
 * (alert: rate > 0 ⇒ limits are per-replica until Redis recovers).
 * Contrast: the idempotency/OTP paths use Redis as a store of record and
 * stay FAIL-CLOSED (503) — see common/interceptors/idempotency.interceptor.ts.
 * The readiness probe (/health/ready) distinguishes the two tiers.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  /**
   * Degraded-mode fixed-window counters (GAP-M06), used only while the
   * Redis path errors. Bounded: expired windows are evicted lazily and the
   * map is hard-capped so a key spray cannot grow memory without limit.
   */
  private readonly fallbackWindows = new Map<string, { count: number; expiresAt: number }>();

  /** Hard cap on degraded-mode window entries (key-spray memory guard). */
  private static readonly FALLBACK_MAX_KEYS = 10_000;

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
      // Safe-default circuit (GAP-M06): keep throttling per replica instead
      // of serving unthrottled; the metric + log make the protection
      // degradation visible until Redis recovers.
      this.metrics?.throttleRedisError();
      this.logger.error(
        `Redis throttler storage failed (${error instanceof Error ? error.message : String(error)}) — throttling per replica (degraded)`
      );
      return this.incrementFallback(key, ttl, throttlerName);
    }
  }

  /**
   * Per-replica fixed-window fallback used while Redis is unavailable.
   * Mirrors the fixed-window semantics of the strict path (window anchored
   * on the first hit, totalHits compared against the route limit by the
   * guard); block markers are not tracked in degraded mode.
   */
  private incrementFallback(
    key: string,
    ttl: number,
    throttlerName: string
  ): ThrottlerStorageRecord {
    const namespaced = `throttle:${throttlerName}:${key}`;
    const now = Date.now();
    let entry = this.fallbackWindows.get(namespaced);
    if (!entry || entry.expiresAt <= now) {
      if (!entry && this.fallbackWindows.size >= RedisThrottlerStorage.FALLBACK_MAX_KEYS) {
        // Lazy eviction under pressure: drop expired windows first; if every
        // window is live the map is reset (windows restart — still bounded,
        // still throttled within each new window).
        for (const [k, v] of this.fallbackWindows) {
          if (v.expiresAt <= now) {
            this.fallbackWindows.delete(k);
          }
        }
        if (this.fallbackWindows.size >= RedisThrottlerStorage.FALLBACK_MAX_KEYS) {
          this.fallbackWindows.clear();
        }
      }
      entry = { count: 0, expiresAt: now + ttl };
      this.fallbackWindows.set(namespaced, entry);
    }
    entry.count += 1;
    return {
      totalHits: entry.count,
      timeToExpire: entry.expiresAt - now,
      isBlocked: false,
      timeToBlockExpire: 0
    };
  }

  private async incrementStrict(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    const namespaced = `throttle:${throttlerName}:${key}`;
    const blockKey = `${namespaced}:blocked`;
    // Perf P3-11: the three read-side commands ride ONE pipelined round
    // trip (INCR + PTTL window + PTTL block marker) instead of three
    // sequential ones. Fixed-window semantics are identical; the
    // conditional writes (PEXPIRE on first hit / TTL-loss race, SET NX
    // block marker) follow in a second pipeline only when needed.
    const reads = await this.redis
      .pipeline()
      .incr(namespaced)
      .pttl(namespaced)
      .pttl(blockKey)
      .exec();
    if (!reads) {
      throw new Error('redis pipeline returned no results');
    }
    const [totalHits, windowTtl, blockTtlAtRead] = reads.map(([error, value]) => {
      if (error) {
        throw error;
      }
      return value;
    }) as [number, number, number];

    let timeToExpire: number;
    let needsWindowExpire = false;
    if (totalHits === 1) {
      // First hit in the window: anchor the fixed window.
      needsWindowExpire = true;
      timeToExpire = ttl;
    } else if (windowTtl < 0) {
      // Key lost its TTL race (expired between INCR and PTTL): reset the window.
      needsWindowExpire = true;
      timeToExpire = ttl;
    } else {
      timeToExpire = windowTtl;
    }

    const overLimit = totalHits > limit && blockDuration > 0;
    let isBlocked = false;
    let timeToBlockExpire = 0;
    if (needsWindowExpire || overLimit) {
      const writes = this.redis.pipeline();
      if (needsWindowExpire) {
        writes.pexpire(namespaced, ttl);
      }
      if (overLimit) {
        // Set the block marker once; its TTL is the remaining block time.
        writes.set(blockKey, '1', 'PX', blockDuration, 'NX');
      }
      const written = await writes.exec();
      if (!written) {
        throw new Error('redis pipeline returned no results');
      }
      const values = written.map(([error, value]) => {
        if (error) {
          throw error;
        }
        return value;
      });
      if (overLimit && values[values.length - 1] !== null) {
        isBlocked = true;
        timeToBlockExpire = blockDuration;
      }
    }
    if (!isBlocked && blockTtlAtRead > 0) {
      isBlocked = true;
      timeToBlockExpire = blockTtlAtRead;
    }

    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire };
  }
}
