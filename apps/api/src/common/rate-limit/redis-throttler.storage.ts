import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import type { KeyValueStore } from '../../redis/key-value-store.js';
import { redisCircuitOpen } from '../../redis/redis-circuit.js';

/**
 * Redis-backed throttler storage (GAP-H03). The default in-memory storage
 * gives every API replica its OWN throttle budget: behind N replicas a
 * client gets N× the intended rate. This storage shares counters through
 * the platform KeyValueStore — distributed exactly when the backend is
 * Redis, per-process in the in-memory e2e/dev backend (single instance,
 * same semantics as the default).
 *
 * Fixed-window counters keyed `throttle:<name>:<key>` — the same window
 * shape @nestjs/throttler's in-memory store implements (ThrottlerStorage-
 * ServiceBase style hit counting), so limits keep their documented
 * per-window meaning, just shared across replicas.
 *
 * Fail-open on backend errors: an unreachable Redis must not take the API
 * down with it (the throttler is protection, not availability). The
 * incident is logged loudly, and the redis-circuit breaker
 * (redis/redis-circuit.ts) reports the degraded tier to /health/ready,
 * which FAILS on Redis errors — Kubernetes stops routing to a degraded
 * pod. OB-09: any future rate-limit whose bypass is a SECURITY issue must
 * subscribe the circuit instead of silently failing open.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly kv: KeyValueStore) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    try {
      const totalHits = await this.kv.incr(`throttle:${throttlerName}:${key}`, ttl);
      const now = Date.now();
      const expiresAt = now + ttl;
      const isBlocked = totalHits > limit;
      return {
        totalHits,
        timeToExpire: ttl,
        isBlocked,
        timeToBlockExpire: isBlocked ? blockDuration : 0
      };
    } catch (error) {
      this.logger.error(
        `throttle counter unavailable — failing OPEN for this request (health probes report degraded): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { totalHits: 0, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}

/**
 * OB-09 audit note: the USSD registration rate counter moved onto the
 * redis-circuit fail-closed tier (ussd.service.ts); this storage stays
 * fail-open for the generic HTTP throttler where a bypass only raises
 * request volume, not a security boundary.
 */
export const REDIS_THROTTLER_FAIL_OPEN = true;

/** Exposed for the degraded-tier health probe (redis-degraded-tier spec). */
export function throttlerRedisCircuitOpen(): boolean {
  return redisCircuitOpen();
}
