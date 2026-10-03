import { describe, expect, it } from 'vitest';
import { InMemoryKeyValueStore } from '../../../src/redis/key-value-store.js';
import { RedisThrottlerStorage } from '../../../src/common/rate-limit/redis-throttler.storage.js';

/**
 * GAP-H03: throttler storage over the shared KeyValueStore — distributed
 * across replicas when the backend is Redis; fail-open on backend errors.
 */
describe('RedisThrottlerStorage (GAP-H03)', () => {
  it('counts hits within the window and blocks past the limit', async () => {
    const storage = new RedisThrottlerStorage(new InMemoryKeyValueStore());
    const first = await storage.increment('ip:1', 60_000, 2, 0, 'default');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
    const second = await storage.increment('ip:1', 60_000, 2, 0, 'default');
    expect(second).toMatchObject({ totalHits: 2, isBlocked: false });
    const third = await storage.increment('ip:1', 60_000, 2, 5_000, 'default');
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true, timeToBlockExpire: 5_000 });
  });

  it('scopes counters per throttler name', async () => {
    const storage = new RedisThrottlerStorage(new InMemoryKeyValueStore());
    await storage.increment('ip:1', 60_000, 1, 0, 'otp');
    const other = await storage.increment('ip:1', 60_000, 1, 0, 'default');
    expect(other.totalHits).toBe(1);
  });

  it('fails OPEN when the backend throws (protection, not availability)', async () => {
    const broken = {
      get: async () => undefined,
      set: async () => undefined,
      setNx: async () => false,
      incr: async () => {
        throw new Error('redis down');
      },
      getdel: async () => undefined,
      delete: async () => undefined
    };
    const storage = new RedisThrottlerStorage(broken);
    const record = await storage.increment('ip:1', 60_000, 1, 0, 'default');
    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(0);
  });
});
