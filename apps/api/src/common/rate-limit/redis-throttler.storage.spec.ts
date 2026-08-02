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
});
