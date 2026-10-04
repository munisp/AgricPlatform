import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

/** In-memory Redis double implementing the commands the storage uses. */
function fakeRedis() {
  const values = new Map<string, { value: string; expiresAt?: number }>();
  let now = Date.now();
  const redis = {
    incr: vi.fn(async (key: string) => {
      const entry = values.get(key);
      const next = Number(entry?.value ?? '0') + 1;
      values.set(key, { value: String(next), expiresAt: entry?.expiresAt });
      return next;
    }),
    pexpire: vi.fn(async (key: string, ms: number) => {
      const entry = values.get(key);
      if (entry) {
        entry.expiresAt = now + ms;
      }
      return 1;
    }),
    pttl: vi.fn(async (key: string) => {
      const entry = values.get(key);
      if (!entry || entry.expiresAt === undefined) {
        return -1;
      }
      return Math.max(0, entry.expiresAt - now);
    }),
    set: vi.fn(async (key: string, value: string, _px: 'PX', ms: number, _nx: 'NX') => {
      if (values.has(key)) {
        return null;
      }
      values.set(key, { value, expiresAt: now + ms });
      return 'OK';
    }),
    // Pipelined execution (perf P3-11): queued commands run through the
    // same mocked command implementations, so mockResolvedValueOnce on a
    // command (e.g. pttl) intercepts pipelined calls too.
    pipeline: vi.fn(() => {
      const commands: Array<() => Promise<unknown>> = [];
      const pipe = {
        incr: (key: string) => (commands.push(() => redis.incr(key)), pipe),
        pexpire: (key: string, ms: number) => (commands.push(() => redis.pexpire(key, ms)), pipe),
        pttl: (key: string) => (commands.push(() => redis.pttl(key)), pipe),
        set: (key: string, value: string, px: 'PX', ms: number, nx: 'NX') => (
          commands.push(() => redis.set(key, value, px, ms, nx)),
          pipe
        ),
        exec: async () => {
          const out: Array<[null, unknown]> = [];
          for (const command of commands) {
            out.push([null, await command()]);
          }
          return out;
        }
      };
      return pipe;
    })
  } as unknown as Redis;
  return { redis, advance: (ms: number) => (now += ms) };
}

describe('RedisThrottlerStorage (Wave P)', () => {
  it('counts hits and sets the window TTL on the first hit', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    const first = await storage.increment('ip:1', 60_000, 3, 0, 'default');
    expect(first.totalHits).toBe(1);
    expect(first.timeToExpire).toBe(60_000);
    const second = await storage.increment('ip:1', 60_000, 3, 0, 'default');
    expect(second.totalHits).toBe(2);
    expect(second.isBlocked).toBe(false);
  });

  it('reports remaining window time on subsequent hits', async () => {
    const { redis, advance } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    await storage.increment('ip:1', 60_000, 300, 0, 'default');
    advance(10_000);
    const hit = await storage.increment('ip:1', 60_000, 300, 0, 'default');
    expect(hit.timeToExpire).toBe(50_000);
  });

  it('blocks with a block-duration marker once the limit is exceeded', async () => {
    const { redis, advance } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    await storage.increment('ip:1', 60_000, 1, 30_000, 'default');
    const over = await storage.increment('ip:1', 60_000, 1, 30_000, 'default');
    expect(over.totalHits).toBe(2);
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBe(30_000);
    advance(5_000);
    const stillBlocked = await storage.increment('ip:1', 60_000, 1, 30_000, 'default');
    expect(stillBlocked.isBlocked).toBe(true);
    expect(stillBlocked.timeToBlockExpire).toBe(25_000);
  });

  it('namespaces keys per throttler so limits are independent', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    await storage.increment('ip:1', 60_000, 1, 0, 'default');
    const other = await storage.increment('ip:1', 60_000, 1, 0, 'strict');
    expect(other.totalHits).toBe(1);
  });

  it('recovers when the window key lost its TTL between INCR and PTTL', async () => {
    const { redis } = fakeRedis();
    (redis.pttl as ReturnType<typeof vi.fn>).mockResolvedValueOnce(-1);
    const storage = new RedisThrottlerStorage(redis);
    const hit = await storage.increment('ip:1', 60_000, 300, 0, 'default');
    expect(hit.timeToExpire).toBe(60_000);
  });

  it('GAP-M06: keeps throttling on the per-replica fallback while Redis errors (never unthrottled)', async () => {
    const { redis } = fakeRedis();
    const throttleRedisError = vi.fn();
    const storage = new RedisThrottlerStorage(redis, {
      throttleRedisError
    } as never);
    (redis.pipeline as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('redis is down');
    });
    const limit = 3;
    let last = { totalHits: 0 };
    for (let i = 0; i < limit + 2; i += 1) {
      last = await storage.increment('ip:1', 60_000, limit, 0, 'default');
    }
    // Every degraded call is counted: the guard sees totalHits > limit and
    // blocks — the outage no longer switches rate limiting off.
    expect(last.totalHits).toBe(limit + 2);
    expect(throttleRedisError).toHaveBeenCalledTimes(limit + 2);
  });

  it('GAP-M06: the fallback expires its window after the ttl', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    (redis.pipeline as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('redis is down');
    });
    vi.useFakeTimers();
    try {
      await storage.increment('ip:1', 1_000, 1, 0, 'default');
      const over = await storage.increment('ip:1', 1_000, 1, 0, 'default');
      expect(over.totalHits).toBe(2);
      vi.advanceTimersByTime(1_100);
      const fresh = await storage.increment('ip:1', 1_000, 1, 0, 'default');
      expect(fresh.totalHits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('GAP-M06: fallback windows are tracked per throttler and the map is hard-capped', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    (redis.pipeline as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('redis is down');
    });
    await storage.increment('ip:1', 60_000, 1, 0, 'default');
    const other = await storage.increment('ip:1', 60_000, 1, 0, 'strict');
    expect(other.totalHits).toBe(1);
    // Key spray stays memory-bounded.
    for (let i = 0; i < 12_000; i += 1) {
      await storage.increment(`ip:spray-${i}`, 60_000, 1, 0, 'default');
    }
    const windows = (storage as unknown as { fallbackWindows: Map<string, unknown> })
      .fallbackWindows;
    expect(windows.size).toBeLessThanOrEqual(10_000);
  }, 20_000);

  it('GAP-M06: returns to the strict Redis path once Redis recovers', async () => {
    const { redis } = fakeRedis();
    const storage = new RedisThrottlerStorage(redis);
    const pipeline = redis.pipeline as ReturnType<typeof vi.fn>;
    const strict = pipeline.getMockImplementation();
    pipeline.mockImplementation(() => {
      throw new Error('redis is down');
    });
    const degraded = await storage.increment('ip:1', 60_000, 300, 0, 'default');
    expect(degraded.totalHits).toBe(1);
    pipeline.mockImplementation(strict!);
    const recovered = await storage.increment('ip:1', 60_000, 300, 0, 'default');
    // The strict path counts from its own (Redis-side) window.
    expect(recovered.totalHits).toBe(1);
    expect(recovered.timeToExpire).toBe(60_000);
  });
});
