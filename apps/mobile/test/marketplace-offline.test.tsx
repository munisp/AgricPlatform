import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryStorage, createOfflineQueue } from '../src/offline/queue';
import { enqueueOrderPlacement, flushOfflineQueue } from '../src/offline/enqueue';
import type { ApiClient } from '../src/api/client';

/**
 * Mobile offline order placement (V-64 / GAP-I02): placing an order
 * offline enqueues the mutation with a STABLE idempotency key, flushes
 * through the API client, and stays queued (with auth-park and chain
 * semantics) when the network or session is down.
 */

function makeClient(behaviour: 'ok' | 'offline' | 'auth' = 'ok'): {
  client: ApiClient;
  calls: { path: string; idempotencyKey?: string }[];
} {
  const calls: { path: string; idempotencyKey?: string }[] = [];
  const client = {
    apiFetch: async <T>(
      path: string,
      init: { idempotencyKey?: string } = {}
    ): Promise<{ data: T }> => {
      calls.push({ path, idempotencyKey: init.idempotencyKey });
      if (behaviour === 'offline') {
        throw new TypeError('Network request failed');
      }
      if (behaviour === 'auth') {
        const error = new Error('unauthorized') as Error & { status: number };
        error.status = 401;
        throw error;
      }
      return { data: { id: 'order-1', listingId: 'listing-1', quantity: 2 } as T };
    }
  } as unknown as ApiClient;
  return { client, calls };
}

describe('mobile offline order placement', () => {
  beforeEach(() => {
    // fresh storage per test
  });

  it('sends the order immediately when online', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const { client, calls } = makeClient('ok');
    await enqueueOrderPlacement(queue, {
      buyerId: 'user-1',
      listingId: 'listing-1',
      quantity: 2,
      formId: 'form-abc'
    });
    const result = await flushOfflineQueue(queue, client);
    expect(result.sent).toBe(1);
    expect(await queue.pending()).toHaveLength(0);
    expect(calls).toEqual([
      { path: '/listings/listing-1/orders', idempotencyKey: 'order.placed:user-1:listing-1:form-abc' }
    ]);
  });

  it('stays queued when offline and replays on the next flush', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const offline = makeClient('offline');
    await enqueueOrderPlacement(queue, {
      buyerId: 'user-1',
      listingId: 'listing-1',
      quantity: 2,
      formId: 'form-abc'
    });
    const first = await flushOfflineQueue(queue, offline.client);
    expect(first.sent).toBe(0);
    expect(await queue.pending()).toHaveLength(1);

    const online = makeClient('ok');
    const second = await flushOfflineQueue(queue, online.client);
    expect(second.sent).toBe(1);
    expect(await queue.pending()).toHaveLength(0);
    expect(online.calls[0].idempotencyKey).toBe('order.placed:user-1:listing-1:form-abc');
  });

  it('a double enqueue of the same form dedupes to one queued mutation', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await enqueueOrderPlacement(queue, {
      buyerId: 'user-1',
      listingId: 'listing-1',
      quantity: 2,
      formId: 'form-abc'
    });
    await enqueueOrderPlacement(queue, {
      buyerId: 'user-1',
      listingId: 'listing-1',
      quantity: 2,
      formId: 'form-abc'
    });
    expect(await queue.pending()).toHaveLength(1);
  });

  it('parks the queue on a 401 (auth-failure park)', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const { client } = makeClient('auth');
    await enqueueOrderPlacement(queue, {
      buyerId: 'user-1',
      listingId: 'listing-1',
      quantity: 2,
      formId: 'form-abc'
    });
    await enqueueOrderPlacement(queue, {
      buyerId: 'user-1',
      listingId: 'listing-2',
      quantity: 1,
      formId: 'form-def'
    });
    const result = await flushOfflineQueue(queue, client);
    expect(result.sent).toBe(0);
    expect(result.parked).toBeGreaterThan(0);
    expect(await queue.pending()).toHaveLength(2);
  });

  it('an expired entry drops out of the queue instead of replaying stale terms', async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    const queue = createOfflineQueue(createInMemoryStorage(), { now: () => new Date() });
    await queue.enqueue({
      kind: 'marketplace.order.created',
      method: 'POST',
      path: '/listings/listing-1/orders',
      payload: { buyerId: 'user-1', quantity: 2 },
      idempotencyKey: 'order.placed:user-1:listing-1:form-old',
      enqueuedAt: undefined as never
    });
    // Backdate the queued entry's timestamp past its 24h TTL.
    const pending = await queue.pending();
    expect(pending).toHaveLength(1);
    // Simulate an aged entry via a fresh queue seeded with a stale entry.
    const aged = createOfflineQueue(createInMemoryStorage());
    const storage = createInMemoryStorage();
    const agedQueue = createOfflineQueue(storage);
    await storage.setItem(
      'nyfn.offline-queue.v1',
      JSON.stringify([
        {
          id: 'req-1',
          kind: 'marketplace.order.created',
          method: 'POST',
          path: '/listings/listing-1/orders',
          payload: { buyerId: 'user-1', quantity: 2 },
          idempotencyKey: 'order.placed:user-1:listing-1:form-old',
          enqueuedAt: staleDate.toISOString()
        }
      ])
    );
    const { client, calls } = makeClient('ok');
    const result = await flushOfflineQueue(agedQueue, client);
    expect(result.sent).toBe(0);
    expect(result.expired).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(await agedQueue.pending()).toHaveLength(0);
  });
});
