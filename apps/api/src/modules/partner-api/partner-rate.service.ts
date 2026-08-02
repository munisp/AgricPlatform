import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../database/persistence.tokens.js';

interface Bucket {
  tokens: number;
  /** Epoch ms of the last refill. */
  refilledAt: number;
}

/** Sliding window length for the Redis-backed counter (one minute). */
export const PARTNER_RATE_WINDOW_MS = 60_000;
/** Redis key TTL: the window plus slack so late writes never resurrect a key. */
const KEY_TTL_MS = PARTNER_RATE_WINDOW_MS + 10_000;

/**
 * Per-client rate bucket (wave P5d, Redis-backed in wave P6b).
 *
 * Backend selection mirrors the wave P1 cache pattern: when REDIS_URL is
 * configured the RedisModule injects a shared client and the bucket becomes a
 * Redis sliding-window counter (multi-replica safe); otherwise an in-memory
 * token bucket preserves the single-replica semantics (development/tests).
 *
 * Redis path (lua-free): one sorted set per client
 * (`partner:rate:{clientId}`) whose members are request timestamps. Each
 * consume trims entries older than the window (ZREMRANGEBYSCORE), counts the
 * remainder (ZCARD) and — while under the limit — appends the new timestamp
 * (ZADD) and refreshes the key TTL (PEXPIRE). The commands are individual
 * atomics, not a transaction; the tiny over-admission race under concurrent
 * bursts is accepted for a rate limiter (documented, fail-safe direction is
 * to reject more, not less).
 *
 * Policy is unchanged: capacity is the client's rate_limit_per_min (default
 * 1000); a full minute's allowance can be absorbed as a burst, after which
 * requests are limited to the sustained per-minute rate.
 *
 * Failure posture: fail OPEN to the in-memory bucket. A Redis outage degrades
 * per-client limiting to single-replica semantics (logged) instead of taking
 * the partner API down; fail-closed is explicitly not required here.
 */
@Injectable()
export class PartnerRateService {
  private readonly logger = new Logger(PartnerRateService.name);
  private readonly buckets = new Map<string, Bucket>();
  /** True once Redis errored; avoids log spam on every request. */
  private redisDegraded = false;

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null
  ) {}

  /**
   * Consumes one token for the client. Returns the remaining allowance, or
   * null when the bucket is empty (caller answers 429).
   */
  async consume(clientId: string, limitPerMin: number, now = Date.now()): Promise<number | null> {
    if (this.redis) {
      try {
        return await this.consumeRedis(clientId, limitPerMin, now);
      } catch (error) {
        if (!this.redisDegraded) {
          this.redisDegraded = true;
          this.logger.warn(
            `Redis rate bucket failed (${(error as Error).message}) — ` +
              'failing open to the in-memory bucket for subsequent requests.'
          );
        }
      }
    }
    return this.consumeMemory(clientId, limitPerMin, now);
  }

  /** Redis sliding-window counter (see class docblock). */
  private async consumeRedis(
    clientId: string,
    limitPerMin: number,
    now: number
  ): Promise<number | null> {
    const key = `partner:rate:${clientId}`;
    const windowStart = now - PARTNER_RATE_WINDOW_MS;
    await this.redis!.zremrangebyscore(key, 0, windowStart);
    const count = await this.redis!.zcard(key);
    if (count >= limitPerMin) {
      return null;
    }
    // Member must be unique per request even at ms resolution.
    await this.redis!.zadd(key, now, `${now}:${Math.random().toString(36).slice(2)}`);
    await this.redis!.pexpire(key, KEY_TTL_MS);
    this.redisDegraded = false;
    return limitPerMin - count - 1;
  }

  /** In-memory token bucket (single-replica fallback; wave P5d semantics). */
  private consumeMemory(clientId: string, limitPerMin: number, now: number): number | null {
    const bucket = this.buckets.get(clientId) ?? { tokens: limitPerMin, refilledAt: now };
    const elapsed = Math.max(0, now - bucket.refilledAt);
    const refill = (elapsed / 60_000) * limitPerMin;
    bucket.tokens = Math.min(limitPerMin, bucket.tokens + refill);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(clientId, bucket);
      return null;
    }
    bucket.tokens -= 1;
    this.buckets.set(clientId, bucket);
    return Math.floor(bucket.tokens);
  }

  /** Test hook: clears all in-memory buckets (Redis windows expire via TTL). */
  reset(): void {
    this.buckets.clear();
  }
}
