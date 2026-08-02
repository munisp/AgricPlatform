import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { PartnerRateService } from './partner-rate.service.js';

/**
 * Minimal in-memory stand-in for the ioredis sorted-set commands the rate
 * bucket uses (zadd/zcard/zremrangebyscore/pexpire). Expiry is swept lazily
 * against the clock the test injects into `consume`.
 */
class FakeRedis {
  readonly sets = new Map<string, Map<string, number>>();
  readonly expiries = new Map<string, number>();
  failNext = false;

  private sweep(key: string, now: number): Map<string, number> {
    const expiresAt = this.expiries.get(key);
    if (expiresAt !== undefined && expiresAt <= now) {
      this.sets.delete(key);
      this.expiries.delete(key);
    }
    return this.sets.get(key) ?? new Map<string, number>();
  }

  private guard(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis down');
    }
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    this.guard();
    const now = this.now();
    const set = this.sweep(key, now);
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= min && score <= max) {
        set.delete(member);
        removed += 1;
      }
    }
    this.sets.set(key, set);
    return removed;
  }

  async zcard(key: string): Promise<number> {
    this.guard();
    return this.sweep(key, this.now()).size;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.guard();
    const set = this.sweep(key, this.now());
    set.set(member, score);
    this.sets.set(key, set);
    return 1;
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    this.guard();
    this.expiries.set(key, this.now() + ttlMs);
    return 1;
  }

  private currentNow = Date.now();
  setNow(now: number): void {
    this.currentNow = now;
  }
  private now(): number {
    return this.currentNow;
  }
}

describe('PartnerRateService (in-memory token bucket fallback)', () => {
  it('allows up to the per-minute limit (full-bucket burst)', async () => {
    const rate = new PartnerRateService();
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      expect(await rate.consume('client-a', 5, now)).not.toBeNull();
    }
    expect(await rate.consume('client-a', 5, now)).toBeNull();
  });

  it('refills tokens over time', async () => {
    const rate = new PartnerRateService();
    const start = Date.now();
    expect(await rate.consume('client-b', 2, start)).not.toBeNull();
    expect(await rate.consume('client-b', 2, start)).not.toBeNull();
    expect(await rate.consume('client-b', 2, start)).toBeNull();
    // 30s later at 2/min -> exactly one token refilled.
    expect(await rate.consume('client-b', 2, start + 30_000)).not.toBeNull();
    expect(await rate.consume('client-b', 2, start + 30_000)).toBeNull();
  });

  it('tracks buckets independently per client', async () => {
    const rate = new PartnerRateService();
    const now = Date.now();
    expect(await rate.consume('client-c', 1, now)).not.toBeNull();
    expect(await rate.consume('client-c', 1, now)).toBeNull();
    expect(await rate.consume('client-d', 1, now)).not.toBeNull();
  });

  it('never refills beyond capacity', async () => {
    const rate = new PartnerRateService();
    const start = Date.now();
    expect(await rate.consume('client-e', 3, start)).not.toBeNull();
    // Long idle period: bucket caps at 3, not more.
    const later = start + 3_600_000;
    expect(await rate.consume('client-e', 3, later)).not.toBeNull();
    expect(await rate.consume('client-e', 3, later)).not.toBeNull();
    expect(await rate.consume('client-e', 3, later)).not.toBeNull();
    expect(await rate.consume('client-e', 3, later)).toBeNull();
  });

  it('reset clears all buckets', async () => {
    const rate = new PartnerRateService();
    const now = Date.now();
    expect(await rate.consume('client-f', 1, now)).not.toBeNull();
    expect(await rate.consume('client-f', 1, now)).toBeNull();
    rate.reset();
    expect(await rate.consume('client-f', 1, now)).not.toBeNull();
  });
});

describe('PartnerRateService (Redis sliding window)', () => {
  function redisBacked() {
    const redis = new FakeRedis();
    const rate = new PartnerRateService(redis as unknown as Redis);
    return { redis, rate };
  }

  it('allows a full-minute burst then rejects within the window', async () => {
    const { redis, rate } = redisBacked();
    const start = 1_800_000_000_000;
    redis.setNow(start);
    for (let i = 0; i < 3; i += 1) {
      expect(await rate.consume('client-r1', 3, start)).toBe(3 - i - 1);
    }
    expect(await rate.consume('client-r1', 3, start)).toBeNull();
    // Half a window later the window has not rolled: still limited.
    redis.setNow(start + 30_000);
    expect(await rate.consume('client-r1', 3, start + 30_000)).toBeNull();
  });

  it('reopens the allowance after the window rolls over', async () => {
    const { redis, rate } = redisBacked();
    const start = 1_800_000_000_000;
    redis.setNow(start);
    expect(await rate.consume('client-r2', 2, start)).not.toBeNull();
    expect(await rate.consume('client-r2', 2, start)).not.toBeNull();
    expect(await rate.consume('client-r2', 2, start)).toBeNull();
    // Window rollover: entries older than 60s are trimmed, allowance reopens.
    const later = start + 61_000;
    redis.setNow(later);
    expect(await rate.consume('client-r2', 2, later)).not.toBeNull();
  });

  it('isolates windows per client', async () => {
    const { redis, rate } = redisBacked();
    const start = 1_800_000_000_000;
    redis.setNow(start);
    expect(await rate.consume('client-r3a', 1, start)).not.toBeNull();
    expect(await rate.consume('client-r3a', 1, start)).toBeNull();
    expect(await rate.consume('client-r3b', 1, start)).not.toBeNull();
    const keys = [...redis.sets.keys()].sort();
    expect(keys).toEqual(['partner:rate:client-r3a', 'partner:rate:client-r3b']);
  });

  it('fails open to the in-memory bucket when Redis errors', async () => {
    const { redis, rate } = redisBacked();
    const start = 1_800_000_000_000;
    redis.setNow(start);
    expect(await rate.consume('client-r4', 1, start)).not.toBeNull();
    expect(await rate.consume('client-r4', 1, start)).toBeNull();
    // Redis outage: the request still succeeds via the memory fallback
    // (fail-open, documented — never 429s healthy clients on cache failure).
    redis.failNext = true;
    expect(await rate.consume('client-r4', 1, start)).not.toBeNull();
    // Once Redis recovers the sliding window is authoritative again.
    redis.setNow(start + 1000);
    expect(await rate.consume('client-r4', 1, start + 1000)).toBeNull();
  });

  it('memory fallback honours per-client isolation after a Redis failure', async () => {
    const { redis, rate } = redisBacked();
    const start = 1_800_000_000_000;
    redis.setNow(start);
    redis.failNext = true;
    expect(await rate.consume('client-r5a', 1, start)).not.toBeNull();
    redis.failNext = true;
    expect(await rate.consume('client-r5a', 1, start)).toBeNull();
    redis.failNext = true;
    expect(await rate.consume('client-r5b', 1, start)).not.toBeNull();
  });
});
