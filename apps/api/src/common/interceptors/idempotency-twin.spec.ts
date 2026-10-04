import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import {
  IDEMPOTENCY_LOCK_WAIT_MS,
  KeyValueIdempotencyStore,
  type IdempotencyStore
} from '../../redis/idempotency.store.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * WP-G11 (Stage 27, V2 idempotency-consistency audit): concurrent-twin
 * serialization in the IdempotencyInterceptor. Two SIMULTANEOUS first
 * requests with the same key previously both missed the cache and both
 * executed the mutation (the check-then-act gap between store.get and the
 * post-response store.save). The per-key advisory lock now serialises
 * them: exactly one execution, and the twin replays the cached response
 * (or 409s on body mismatch) once the first response is stored.
 */

class MemoryStore implements IdempotencyStore {
  readonly entries = new Map<string, unknown>();
  async get(scopedKey: string) {
    return this.entries.get(scopedKey);
  }
  async save(scopedKey: string, body: unknown) {
    if (!this.entries.has(scopedKey)) {
      this.entries.set(scopedKey, body);
    }
  }
}

function makeContext(options: {
  method?: string;
  url?: string;
  key?: string;
  body?: unknown;
}): { context: ExecutionContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const request = {
    method: options.method ?? 'POST',
    originalUrl: options.url ?? '/api/orders',
    headers: options.key ? { 'idempotency-key': options.key } : {},
    body: options.body
  };
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    }
  };
  const http = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response
    })
  };
  return { context: http as unknown as ExecutionContext, headers };
}

const metrics = { idempotentReplay: () => undefined };

function makeInterceptor() {
  const store = new MemoryStore();
  const interceptor = new IdempotencyInterceptor(store, metrics as never);
  return { store, interceptor };
}

describe('IdempotencyInterceptor — WP-G11 concurrent-twin serialization', () => {
  it('two simultaneous same-key first-requests execute the handler EXACTLY once', async () => {
    const { store, interceptor } = makeInterceptor();
    let executions = 0;
    // A slow handler: both requests are in flight while the first executes.
    const gate = new Subject<unknown>();
    const slowHandler: CallHandler = {
      handle: () => {
        executions += 1;
        return gate.asObservable();
      }
    };
    const body = { listingId: 'l1', quantity: 4 };
    const first = makeContext({ key: 'twin-1', body });
    const second = makeContext({ key: 'twin-1', body });

    const firstCall = interceptor.intercept(first.context, slowHandler);
    const secondCall = interceptor.intercept(second.context, slowHandler);
    const firstResult = firstValueFrom(await firstCall);
    // The twin's intercept() resolves only after the first request finishes
    // (that is the serialization under test) — chain, do not await it here.
    const secondResult = secondCall.then((observable) => firstValueFrom(observable));
    // Let both interceptors reach their decision points, then complete the
    // (single) execution.
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.next({ id: 'order-1' });
    gate.complete();
    const [a, b] = await Promise.all([firstResult, secondResult]);
    expect(executions).toBe(1);
    expect(a).toEqual({ id: 'order-1' });
    // The twin replayed the cached response — it never executed.
    expect(b).toEqual({ id: 'order-1' });
    expect(first.headers['Idempotent-Replay']).toBeUndefined();
    expect(second.headers['Idempotent-Replay']).toBe('true');
    expect(store.entries.size).toBe(1);
  });

  it('a simultaneous same-key twin with a DIFFERENT body 409s without executing', async () => {
    const { interceptor } = makeInterceptor();
    let executions = 0;
    const gate = new Subject<unknown>();
    const slowHandler: CallHandler = {
      handle: () => {
        executions += 1;
        return gate.asObservable();
      }
    };
    const firstCall = interceptor.intercept(
      makeContext({ key: 'twin-2', body: { amount: 100 } }).context,
      slowHandler
    );
    const secondCall = interceptor.intercept(
      makeContext({ key: 'twin-2', body: { amount: 999 } }).context,
      slowHandler
    );
    const firstResult = firstValueFrom(await firstCall);
    const secondResult = secondCall.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.next({ id: 'order-1' });
    gate.complete();
    const [a, b] = await Promise.all([firstResult, secondResult]);
    expect(a).toEqual({ id: 'order-1' });
    expect(executions).toBe(1);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.error).toBeInstanceOf(ConflictException);
    }
  });

  it('a failed first request releases the key: the next caller retries as a fresh first request', async () => {
    const { interceptor } = makeInterceptor();
    let executions = 0;
    // First request errors on subscription.
    const errorHandler: CallHandler = {
      handle: () => {
        executions += 1;
        return throwError(() => new Error('boom'));
      }
    };
    await expect(
      firstValueFrom(
        await interceptor.intercept(
          makeContext({ key: 'twin-3', body: { x: 1 } }).context,
          errorHandler
        )
      )
    ).rejects.toThrowError('boom');
    // Retry with the same key + same body executes (nothing was cached).
    const retried = await firstValueFrom(
      await interceptor.intercept(makeContext({ key: 'twin-3', body: { x: 1 } }).context, {
        handle: () => {
          executions += 1;
          return of({ id: 'order-retry' });
        }
      })
    );
    expect(retried).toEqual({ id: 'order-retry' });
    expect(executions).toBe(2);
  });

  it('sequential replay after a completed first request is unchanged', async () => {
    const { interceptor } = makeInterceptor();
    let executions = 0;
    const counting: CallHandler = {
      handle: () => {
        executions += 1;
        return of({ id: 'order-9' });
      }
    };
    const body = { listingId: 'l9' };
    const first = makeContext({ key: 'twin-4', body });
    await firstValueFrom(await interceptor.intercept(first.context, counting));
    const second = makeContext({ key: 'twin-4', body });
    const replayed = await firstValueFrom(await interceptor.intercept(second.context, counting));
    expect(replayed).toEqual({ id: 'order-9' });
    expect(second.headers['Idempotent-Replay']).toBe('true');
    expect(executions).toBe(1);
  });
});

/**
 * GAP-M07: the advisory lock is now distributed via the store (Redis
 * SET NX PX in production). Two interceptor INSTANCES — stand-ins for two
 * API replicas — share one store over an in-memory Redis double, so only
 * the distributed layer can serialise their twins.
 */
describe('IdempotencyInterceptor — GAP-M07 distributed lock', () => {
  function makeReplicaPair() {
    // In-memory Redis stub (consistent with the repo's KV test doubles):
    // one shared backend, two interceptor "replicas".
    const kv = new InMemoryKeyValueStore();
    const store = new KeyValueIdempotencyStore(kv);
    const replicaA = new IdempotencyInterceptor(store, metrics as never);
    const replicaB = new IdempotencyInterceptor(store, metrics as never);
    return { kv, store, replicaA, replicaB };
  }

  it('serialises same-key twins ACROSS replicas: exactly one execution, twin replays', async () => {
    const { replicaA, replicaB } = makeReplicaPair();
    let executions = 0;
    const gate = new Subject<unknown>();
    const slowHandler: CallHandler = {
      handle: () => {
        executions += 1;
        return gate.asObservable();
      }
    };
    const body = { listingId: 'l1', quantity: 4 };
    const first = makeContext({ key: 'dist-1', body });
    const second = makeContext({ key: 'dist-1', body });

    const firstResult = firstValueFrom(await replicaA.intercept(first.context, slowHandler));
    const secondResult = replicaB
      .intercept(second.context, slowHandler)
      .then((observable) => firstValueFrom(observable));
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.next({ id: 'order-1' });
    gate.complete();
    const [a, b] = await Promise.all([firstResult, secondResult]);
    expect(executions).toBe(1);
    expect(a).toEqual({ id: 'order-1' });
    expect(b).toEqual({ id: 'order-1' });
    expect(second.headers['Idempotent-Replay']).toBe('true');
  });

  it('the lock is released after the first response is cached: a later request replays without waiting', async () => {
    const { replicaA, replicaB } = makeReplicaPair();
    const handler: CallHandler = { handle: () => of({ id: 'order-2' }) };
    const body = { x: 1 };
    await firstValueFrom(
      await replicaA.intercept(makeContext({ key: 'dist-2', body }).context, handler)
    );
    const replay = makeContext({ key: 'dist-2', body });
    const started = Date.now();
    const body2 = await firstValueFrom(await replicaB.intercept(replay.context, handler));
    expect(body2).toEqual({ id: 'order-2' });
    expect(replay.headers['Idempotent-Replay']).toBe('true');
    // No lock wait: well under the 10s acquisition budget.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('fails CLOSED (503) when the lock cannot be acquired in time', async () => {
    const { store, replicaA } = makeReplicaPair();
    // Another replica holds the lock and never releases (crash simulation;
    // the TTL is the real-world backstop — the waiter must not proceed
    // unlocked).
    const body = { x: 1 };
    const scopedKey = `POST:/api/orders:ip:unknown:dist-3`;
    await store.acquireLock(scopedKey);
    vi.useFakeTimers();
    try {
      let executions = 0;
      const handler: CallHandler = {
        handle: () => {
          executions += 1;
          return of({ id: 'never' });
        }
      };
      const pending = replicaA.intercept(makeContext({ key: 'dist-3', body }).context, handler);
      const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
      await vi.advanceTimersByTimeAsync(IDEMPOTENCY_LOCK_WAIT_MS + 100);
      await assertion;
      expect(executions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a store without a lock primitive still serialises same-replica twins (in-process chain)', async () => {
    const store = new MemoryStore(); // no acquireLock
    const interceptor = new IdempotencyInterceptor(store, metrics as never);
    let executions = 0;
    const gate = new Subject<unknown>();
    const slowHandler: CallHandler = {
      handle: () => {
        executions += 1;
        return gate.asObservable();
      }
    };
    const body = { y: 2 };
    const first = firstValueFrom(
      await interceptor.intercept(makeContext({ key: 'dist-4', body }).context, slowHandler)
    );
    const second = interceptor
      .intercept(makeContext({ key: 'dist-4', body }).context, slowHandler)
      .then((observable) => firstValueFrom(observable));
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.next({ id: 'order-4' });
    gate.complete();
    await Promise.all([first, second]);
    expect(executions).toBe(1);
  });
});
