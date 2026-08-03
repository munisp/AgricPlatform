import { describe, expect, it, vi } from 'vitest';
import {
  createVoiceMenuStateStore,
  InMemoryVoiceMenuStateStore,
  RedisVoiceMenuStateStore
} from './voice-menu-state.store.js';

describe('InMemoryVoiceMenuStateStore', () => {
  it('round-trips menu state and forgets on delete', async () => {
    const store = new InMemoryVoiceMenuStateStore();
    await store.set('s1', { menu: 'symptom', crop: 'Maize' }, 60_000);
    expect(await store.get('s1')).toEqual({ menu: 'symptom', crop: 'Maize' });
    await store.delete('s1');
    expect(await store.get('s1')).toBeUndefined();
  });

  it('expires entries after their TTL', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryVoiceMenuStateStore();
      await store.set('s1', { menu: 'crop' }, 1_000);
      vi.advanceTimersByTime(1_500);
      expect(await store.get('s1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RedisVoiceMenuStateStore', () => {
  it('stores JSON with a PX TTL under the voice:menu prefix', async () => {
    const calls: unknown[][] = [];
    const redis = {
      get: async () => null,
      set: async (...args: unknown[]) => {
        calls.push(args);
        return 'OK';
      },
      del: async () => 1
    };
    const store = new RedisVoiceMenuStateStore(redis as never);
    await store.set('s1', { menu: 'crop' }, 5_000);
    expect(calls[0]).toEqual(['voice:menu:s1', JSON.stringify({ menu: 'crop' }), 'PX', 5_000]);
  });
});

describe('createVoiceMenuStateStore — REDIS_URL-gated selection', () => {
  it('picks redis when a client exists, memory otherwise', () => {
    expect(createVoiceMenuStateStore(null).name).toBe('memory');
    const fakeRedis = { get: async () => null } as never;
    expect(createVoiceMenuStateStore(fakeRedis).name).toBe('redis');
  });
});
