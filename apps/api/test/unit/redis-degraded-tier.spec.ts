import { ServiceUnavailableException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor } from '../../src/common/interceptors/idempotency.interceptor.js';
import { RedisThrottlerStorage } from '../../src/common/rate-limit/redis-throttler.storage.js';
import type { IdempotencyStore } from '../../src/redis/idempotency.store.js';
import type { KeyValueStore } from '../../src/redis/key-value-store.js';
import { KeyValueOtpChallengeStore } from '../../src/redis/otp-challenge.store.js';

/**
 * V-77 chaos spec — Redis degraded tier.
 *
 * Redis down means TWO different behaviours by tier:
 *   cache tier (throttler storage): FAIL-OPEN — requests keep flowing,
 *     unthrottled, with agric_throttle_redis_errors_total incremented;
 *   store tier (idempotency + OTP): FAIL-CLOSED — keyed mutations and OTP
 *     flows answer a retryable 503, never a duplicate mutation, never an
 *     unauthenticated guess window.
 *
 * The readiness split (/health/ready: redis degraded-not-down with a
 * tier-aware reason) is covered in src/health/health.controller.spec.ts.
 */

/** Redis double where every command rejects (outage). */
function deadRedis(): Redis {
  const fail = () => Promise.reject(new Error('ECONNREFUSED — redis down'));
  return {
    incr: fail,
    pexpire: fail,
    pttl: fail,
    set: fail,
    get: fail,
    getdel: fail,
    del: fail
  } as unknown as Redis;
}

function deadKv(): KeyValueStore {
  const fail = () => Promise.reject(new Error('ECONNREFUSED — redis down'));
  return { get: fail, set: fail, setNx: fail, incr: fail, getdel: fail, delete: fail };
}

describe('V-77 cache tier: RedisThrottlerStorage fails OPEN with metric', () => {
  it('serves the request unthrottled and counts the error when redis is down', async () => {
    const metrics = { throttleRedisError: vi.fn() };
    const storage = new RedisThrottlerStorage(deadRedis(), metrics as never);
    const record = await storage.increment('ip:1', 60_000, 300, 0, 'default');
    // Non-blocking record: the request proceeds as if it were the first hit.
    expect(record).toEqual({
      totalHits: 1,
      timeToExpire: 60_000,
      isBlocked: false,
      timeToBlockExpire: 0
    });
    expect(metrics.throttleRedisError).toHaveBeenCalledTimes(1);

    // Every failing call is metered — the metric rate measures the outage.
    await storage.increment('ip:2', 60_000, 300, 0, 'default');
    expect(metrics.throttleRedisError).toHaveBeenCalledTimes(2);
  });

  it('still works without a metrics service (metric is best-effort)', async () => {
    const storage = new RedisThrottlerStorage(deadRedis());
    const record = await storage.increment('ip:1', 60_000, 300, 0, 'default');
    expect(record.isBlocked).toBe(false);
  });

  it('a mid-sequence failure (after INCR) also fails open, not half-applied', async () => {
    const redis = {
      incr: vi.fn(async () => 5), // over-limit hit
      pexpire: vi.fn(async () => 1),
      pttl: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED mid-window'))),
      set: vi.fn(async () => 'OK')
    } as unknown as Redis;
    const metrics = { throttleRedisError: vi.fn() };
    const storage = new RedisThrottlerStorage(redis, metrics as never);
    const record = await storage.increment('ip:1', 60_000, 1, 30_000, 'default');
    expect(record.isBlocked).toBe(false);
    expect(metrics.throttleRedisError).toHaveBeenCalledTimes(1);
  });
});

describe('V-77 store tier: IdempotencyInterceptor fails CLOSED (503)', () => {
  function makeContext(options: { method?: string; key?: string }): ExecutionContext {
    const request = {
      method: options.method ?? 'POST',
      originalUrl: '/api/orders',
      headers: options.key ? { 'idempotency-key': options.key } : {},
      body: { listingId: 'l1' },
      ip: '10.0.0.1',
      user: undefined
    };
    const response = { setHeader: () => undefined };
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
    } as unknown as ExecutionContext;
  }
  const metrics = { idempotentReplay: () => undefined };
  const handler = (body: unknown): CallHandler => ({ handle: () => of(body) });

  it('mutation WITH Idempotency-Key → 503 when the store is unreachable', async () => {
    const failingStore: IdempotencyStore = {
      get: () => Promise.reject(new Error('ECONNREFUSED — redis down')),
      save: () => Promise.reject(new Error('ECONNREFUSED — redis down'))
    };
    const interceptor = new IdempotencyInterceptor(failingStore, metrics as never);
    const failure = await interceptor
      .intercept(makeContext({ key: 'order-1' }), handler({ id: 'order-1' }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getStatus()).toBe(503);
    expect((failure as ServiceUnavailableException).message).toContain('Idempotency store');
  });

  it('a store failure on SAVE (after the handler ran) also answers 503, not a raw 500', async () => {
    const failingSave: IdempotencyStore = {
      get: () => Promise.resolve(undefined),
      save: () => Promise.reject(new Error('ECONNREFUSED — redis down'))
    };
    const interceptor = new IdempotencyInterceptor(failingSave, metrics as never);
    const result = interceptor.intercept(makeContext({ key: 'order-2' }), handler({ ok: true }));
    await expect(firstValueFrom(await result)).rejects.toThrowError(ServiceUnavailableException);
  });

  it('reads (GET) and keyless mutations are UNAFFECTED by the outage', async () => {
    const failingStore: IdempotencyStore = {
      get: () => Promise.reject(new Error('ECONNREFUSED — redis down')),
      save: () => Promise.reject(new Error('ECONNREFUSED — redis down'))
    };
    const interceptor = new IdempotencyInterceptor(failingStore, metrics as never);
    // GET with a key never touches the store.
    await expect(
      firstValueFrom(
        await interceptor.intercept(makeContext({ method: 'GET', key: 'k' }), handler('served'))
      )
    ).resolves.toBe('served');
    // POST without a key never touches the store either.
    await expect(
      firstValueFrom(await interceptor.intercept(makeContext({}), handler('served')))
    ).resolves.toBe('served');
  });
});

describe('V-77 store tier: OTP challenge store fails CLOSED (503)', () => {
  it('challenge read/write/delete surface a retryable 503, never fail open', async () => {
    const store = new KeyValueOtpChallengeStore(deadKv());
    await expect(store.get('otp-1')).rejects.toThrowError(ServiceUnavailableException);
    await expect(store.consume('otp-1')).rejects.toThrowError(ServiceUnavailableException);
    await expect(
      store.save(
        { id: 'otp-1', phone: '+2348000000000', codeHash: 'x', expiresAt: 0, attempts: 0 },
        60_000
      )
    ).rejects.toThrowError(ServiceUnavailableException);
    await expect(store.registerAttempt('otp-1', 60_000)).rejects.toThrowError(/503|OTP store/);
    await expect(store.registerPhoneRequest('+2348000000000', 60_000)).rejects.toThrowError(
      ServiceUnavailableException
    );
  });

  it('the 503 is explicit about fail-closed auth (operator-facing message)', async () => {
    const store = new KeyValueOtpChallengeStore(deadKv());
    const failure = await store.get('otp-1').catch((error: unknown) => error);
    expect((failure as ServiceUnavailableException).message).toContain('fail-closed');
  });
});
