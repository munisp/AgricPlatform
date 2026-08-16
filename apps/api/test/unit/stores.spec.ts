import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyValueIdempotencyStore } from '../../src/redis/idempotency.store.js';
import { InMemoryKeyValueStore } from '../../src/redis/key-value-store.js';
import {
  KeyValueOtpChallengeStore,
  type OtpChallenge
} from '../../src/redis/otp-challenge.store.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('InMemoryKeyValueStore', () => {
  it('round-trips values and honours TTL expiry', async () => {
    vi.useFakeTimers();
    const kv = new InMemoryKeyValueStore();
    await kv.set('k', 'v', 1000);
    expect(await kv.get('k')).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(await kv.get('k')).toBeUndefined();
  });

  it('setNx only writes when absent', async () => {
    const kv = new InMemoryKeyValueStore();
    expect(await kv.setNx('k', 'first')).toBe(true);
    expect(await kv.setNx('k', 'second')).toBe(false);
    expect(await kv.get('k')).toBe('first');
  });

  it('getdel reads once and removes', async () => {
    const kv = new InMemoryKeyValueStore();
    await kv.set('k', 'v');
    expect(await kv.getdel('k')).toBe('v');
    expect(await kv.getdel('k')).toBeUndefined();
  });

  it('incr counts atomically and anchors the TTL window on the first increment', async () => {
    vi.useFakeTimers();
    const kv = new InMemoryKeyValueStore();
    // Concurrent increments all count — no lost updates (audit C2-5/C3).
    const counts = await Promise.all(Array.from({ length: 20 }, () => kv.incr('counter', 60_000)));
    expect(Math.max(...counts)).toBe(20);
    expect(await kv.get('counter')).toBe('20');
    // The window does not slide: later increments keep the original expiry.
    vi.advanceTimersByTime(59_000);
    expect(await kv.incr('counter', 60_000)).toBe(21);
    vi.advanceTimersByTime(1_001);
    expect(await kv.get('counter')).toBeUndefined();
    expect(await kv.incr('counter', 60_000)).toBe(1);
  });
});

describe('KeyValueIdempotencyStore', () => {
  it('serves cached bodies and keeps the first writer (NX semantics)', async () => {
    const store = new KeyValueIdempotencyStore(new InMemoryKeyValueStore());
    expect(await store.get('POST:/x:key1')).toBeUndefined();
    await store.save('POST:/x:key1', { data: 1 });
    await store.save('POST:/x:key1', { data: 2 });
    expect(await store.get('POST:/x:key1')).toEqual({ data: 1 });
  });

  it('expires after the TTL window', async () => {
    vi.useFakeTimers();
    const store = new KeyValueIdempotencyStore(new InMemoryKeyValueStore());
    await store.save('k', { ok: true }, 500);
    expect(await store.get('k')).toEqual({ ok: true });
    vi.advanceTimersByTime(501);
    expect(await store.get('k')).toBeUndefined();
  });
});

function challenge(id: string, phone = '+2348010000001'): OtpChallenge {
  return { id, phone, codeHash: 'hash', expiresAt: Date.now() + 60_000, attempts: 0 };
}

describe('KeyValueOtpChallengeStore', () => {
  it('saves and reads challenges', async () => {
    const store = new KeyValueOtpChallengeStore(new InMemoryKeyValueStore());
    await store.save(challenge('otp-1'), 60_000);
    expect((await store.get('otp-1'))?.phone).toBe('+2348010000001');
  });

  it('consume is single-use', async () => {
    const store = new KeyValueOtpChallengeStore(new InMemoryKeyValueStore());
    await store.save(challenge('otp-1'), 60_000);
    expect((await store.consume('otp-1'))?.id).toBe('otp-1');
    expect(await store.consume('otp-1')).toBeUndefined();
    expect(await store.get('otp-1')).toBeUndefined();
  });

  it('invalidateForPhone removes the outstanding challenge for that phone', async () => {
    const store = new KeyValueOtpChallengeStore(new InMemoryKeyValueStore());
    await store.save(challenge('otp-1'), 60_000);
    await store.save(challenge('otp-2'), 60_000); // same phone supersedes
    await store.invalidateForPhone('+2348010000001');
    expect(await store.get('otp-2')).toBeUndefined();
    // A challenge for another phone is untouched.
    await store.save(challenge('otp-3', '+2348099999999'), 60_000);
    await store.invalidateForPhone('+2348010000001');
    expect(await store.get('otp-3')).toBeDefined();
  });

  it('deleting a superseded challenge keeps the phone index of the newest one', async () => {
    const store = new KeyValueOtpChallengeStore(new InMemoryKeyValueStore());
    await store.save(challenge('otp-1'), 60_000);
    await store.save(challenge('otp-2'), 60_000);
    await store.delete('otp-1');
    expect(await store.get('otp-2')).toBeDefined();
  });

  it('counts per-phone verification failures in a fixed window (audit C3)', async () => {
    vi.useFakeTimers();
    const store = new KeyValueOtpChallengeStore(new InMemoryKeyValueStore());
    expect(await store.phoneFailureCount('+2348010000001')).toBe(0);
    expect(await store.registerPhoneFailure('+2348010000001', 60_000)).toBe(1);
    expect(await store.registerPhoneFailure('+2348010000001', 60_000)).toBe(2);
    // Other phones are unaffected.
    expect(await store.phoneFailureCount('+2348099999999')).toBe(0);
    // The window expires and the counter resets.
    vi.advanceTimersByTime(60_001);
    expect(await store.phoneFailureCount('+2348010000001')).toBe(0);
  });
});
