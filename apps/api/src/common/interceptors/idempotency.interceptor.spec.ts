import { ConflictException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { IdempotencyStore } from '../../redis/idempotency.store.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

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
const handler = (body: unknown): CallHandler => ({ handle: () => of(body) });

function makeInterceptor() {
  const store = new MemoryStore();
  const interceptor = new IdempotencyInterceptor(store, metrics as never);
  return { store, interceptor };
}

describe('IdempotencyInterceptor', () => {
  it('passes through non-mutating methods and requests without a key', async () => {
    const { store, interceptor } = makeInterceptor();
    const get = await firstValueFrom(
      await interceptor.intercept(makeContext({ method: 'GET', key: 'k' }).context, handler('ok'))
    );
    expect(get).toBe('ok');
    const noKey = await firstValueFrom(
      await interceptor.intercept(makeContext({}).context, handler('ok'))
    );
    expect(noKey).toBe('ok');
    expect(store.entries.size).toBe(0);
  });

  it('caches the first response and replays it for the same key and body', async () => {
    const { interceptor } = makeInterceptor();
    const first = makeContext({ key: 'order-1', body: { listingId: 'l1' } });
    const initial = await firstValueFrom(await interceptor.intercept(first.context, handler({ id: 'order-1' })));
    expect(initial).toEqual({ id: 'order-1' });
    expect(first.headers['Idempotent-Replay']).toBeUndefined();

    const second = makeContext({ key: 'order-1', body: { listingId: 'l1' } });
    const replayed = await firstValueFrom(
      await interceptor.intercept(second.context, handler({ id: 'order-DIFFERENT' }))
    );
    expect(replayed).toEqual({ id: 'order-1' });
    expect(second.headers['Idempotent-Replay']).toBe('true');
  });

  it('rejects the same key with a different body with 409', async () => {
    const { interceptor } = makeInterceptor();
    await firstValueFrom(
      await interceptor.intercept(
        makeContext({ key: 'order-2', body: { listingId: 'l1' } }).context,
        handler({ id: 'order-2' })
      )
    );
    await expect(
      interceptor.intercept(
        makeContext({ key: 'order-2', body: { listingId: 'l2' } }).context,
        handler({ id: 'order-3' })
      )
    ).rejects.toThrowError(ConflictException);
  });

  it('scopes keys by method and URL', async () => {
    const { interceptor } = makeInterceptor();
    await firstValueFrom(
      await interceptor.intercept(
        makeContext({ key: 'k', url: '/api/a', body: { x: 1 } }).context,
        handler('a')
      )
    );
    const otherUrl = await firstValueFrom(
      await interceptor.intercept(
        makeContext({ key: 'k', url: '/api/b', body: { x: 1 } }).context,
        handler('b')
      )
    );
    expect(otherUrl).toBe('b');
  });

  it('replays legacy plain-body cache entries (pre-envelope)', async () => {
    const { store, interceptor } = makeInterceptor();
    store.entries.set('POST:/api/orders:legacy', { id: 'order-legacy' });
    const ctx = makeContext({ key: 'legacy', body: { anything: true } });
    const replayed = await firstValueFrom(await interceptor.intercept(ctx.context, handler('new')));
    expect(replayed).toEqual({ id: 'order-legacy' });
    expect(ctx.headers['Idempotent-Replay']).toBe('true');
  });
});
