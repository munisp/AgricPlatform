import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OFFLINE_TTL_MS,
  OFFLINE_KIND_TTL_MS,
  createInMemoryStorage,
  createOfflineQueue
} from '../src/offline/queue';

/**
 * V-64: per-kind TTL + expired-entry surfacing + stop-on-error per chain.
 * A month-old mutation must not apply month-old prices as current truth,
 * and a dependent mutation must not replay after its parent failed.
 */

const BASE = {
  kind: 'livestock.animal.registered',
  method: 'POST' as const,
  path: '/livestock/animals',
  payload: { tag: 'NG-1' }
};

function queueAt(nowIso: string) {
  let current = new Date(nowIso);
  const queue = createOfflineQueue(createInMemoryStorage(), { now: () => current });
  return { queue, setNow: (iso: string) => (current = new Date(iso)) };
}

const T0 = '2026-01-01T00:00:00.000Z';
const LATER = new Date(Date.parse(T0) + DEFAULT_OFFLINE_TTL_MS + 60_000).toISOString();
const WITHIN = new Date(Date.parse(T0) + 60_000).toISOString();

describe('offline queue TTL (V-64)', () => {
  it('drops expired entries WITHOUT replaying and surfaces them in the result', async () => {
    const { queue, setNow } = queueAt(T0);
    const stale = await queue.enqueue({ ...BASE, idempotencyKey: 'stale' });
    const fresh = await queue.enqueue({ ...BASE, idempotencyKey: 'fresh' });
    setNow(LATER); // past the default 7-day TTL for both
    await queue.enqueue({ ...BASE, idempotencyKey: 'brand-new' });

    const sent: string[] = [];
    const result = await queue.flush(async (request) => {
      sent.push(request.idempotencyKey);
    });

    expect(sent).toEqual(['brand-new']);
    expect(result.sent).toBe(1);
    expect(result.expired.map((entry) => entry.idempotencyKey)).toEqual(['stale', 'fresh']);
    // Expired entries are removed from the queue — not retried forever;
    // the one fresh entry was sent and cleared.
    expect(await queue.pending()).toHaveLength(0);
  });

  it('applies per-kind TTL overrides (booking kinds age out in 24h)', async () => {
    const bookingTtl = OFFLINE_KIND_TTL_MS['services.booking.created'];
    expect(bookingTtl).toBeLessThan(DEFAULT_OFFLINE_TTL_MS);

    const { queue, setNow } = queueAt(T0);
    await queue.enqueue({
      ...BASE,
      kind: 'services.booking.created',
      idempotencyKey: 'booking'
    });
    await queue.enqueue({ ...BASE, idempotencyKey: 'animal' });
    setNow(new Date(Date.parse(T0) + bookingTtl + 60_000).toISOString());

    const result = await queue.flush(async () => ({}));
    expect(result.expired.map((entry) => entry.idempotencyKey)).toEqual(['booking']);
    expect(result.sent).toBe(1); // the animal registration is still fresh
  });

  it('does not expire entries inside their TTL window', async () => {
    const { queue, setNow } = queueAt(T0);
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    setNow(WITHIN);
    const result = await queue.flush(async () => ({}));
    expect(result).toEqual({ sent: 1, failed: 0, parked: 0, blocked: 0, expired: [] });
  });

  it('surfaces currently-expired pending entries via expired() for the outbox UI', async () => {
    const { queue, setNow } = queueAt(T0);
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    expect(await queue.expired()).toHaveLength(0);
    setNow(LATER);
    const stale = await queue.expired();
    expect(stale.map((entry) => entry.idempotencyKey)).toEqual(['k1']);
  });
});

describe('offline queue stop-on-error per chain (V-64)', () => {
  it('blocks later entries in the failed entry chain, attempts other chains', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue({ ...BASE, idempotencyKey: 'create-plot', chainKey: 'farm_plot:p-1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'update-plot', chainKey: 'farm_plot:p-1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'unrelated', chainKey: 'farm_plot:p-2' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'independent' }); // no chain

    const attempted: string[] = [];
    const result = await queue.flush(async (request) => {
      attempted.push(request.idempotencyKey);
      if (request.idempotencyKey === 'create-plot') {
        throw new Error('server 500');
      }
    });

    // The dependent update never replays against a parent that failed;
    // other chains and independent entries proceed normally.
    expect(attempted).toEqual(['create-plot', 'unrelated', 'independent']);
    expect(result).toMatchObject({ sent: 2, failed: 1, parked: 0, blocked: 1 });
    expect((await queue.pending()).map((entry) => entry.idempotencyKey)).toEqual([
      'create-plot',
      'update-plot'
    ]);

    // Next flush retries the chain from the parent, in order.
    const second = await queue.flush(async () => ({}));
    expect(second).toEqual({ sent: 2, failed: 0, parked: 0, blocked: 0, expired: [] });
  });

  it('a failed entry does NOT block same-kind entries without a chainKey', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k2' });
    const result = await queue.flush(async (request) => {
      if (request.idempotencyKey === 'k1') throw new Error('boom');
    });
    expect(result).toEqual({ sent: 1, failed: 1, parked: 0, blocked: 0, expired: [] });
  });
});
