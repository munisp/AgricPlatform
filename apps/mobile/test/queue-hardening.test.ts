import { describe, expect, it } from 'vitest';
import {
  createInMemoryStorage,
  createOfflineQueue,
  isAuthFailure,
  type QueuedRequest
} from '../src/offline/queue';

const BASE = {
  kind: 'livestock.animal.registered',
  method: 'POST' as const,
  path: '/livestock/animals',
  payload: { species: 'goat', breed: 'Sahel', sex: 'female', state: 'Kano' }
};

function authError() {
  const error = new Error('Unauthorized');
  (error as { status?: number }).status = 401;
  return error;
}

describe('offline queue hardening', () => {
  it('dedupes by idempotency key — a double enqueue keeps one entry', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const first = await queue.enqueue({ ...BASE, idempotencyKey: 'idem-animal-1' });
    const second = await queue.enqueue({ ...BASE, idempotencyKey: 'idem-animal-1' });
    expect(second.id).toBe(first.id);
    expect(await queue.pending()).toHaveLength(1);
  });

  it('keeps distinct idempotency keys as separate entries', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k2' });
    expect(await queue.pending()).toHaveLength(2);
  });

  it('isAuthFailure recognises 401-shaped errors only', () => {
    expect(isAuthFailure(authError())).toBe(true);
    expect(isAuthFailure(new Error('offline'))).toBe(false);
    expect(isAuthFailure({ status: 500 })).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });

  it('parks the remainder unattempted after a 401 and reports parked counts', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k2' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k3' });

    const attempted: string[] = [];
    const result = await queue.flush(async (request) => {
      attempted.push(request.idempotencyKey);
      if (request.idempotencyKey === 'k1') throw authError();
    });

    expect(result).toEqual({ sent: 0, failed: 0, parked: 3 });
    // k2 and k3 were never attempted.
    expect(attempted).toEqual(['k1']);
    // Everything stays queued in the original order.
    expect((await queue.pending()).map((entry) => entry.idempotencyKey)).toEqual(['k1', 'k2', 'k3']);
  });

  it('replays parked entries in order on the next flush after re-login', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k2' });

    await queue.flush(async () => {
      throw authError();
    });

    const replayed: string[] = [];
    const second = await queue.flush(async (request) => {
      replayed.push(request.idempotencyKey);
    });
    expect(second).toEqual({ sent: 2, failed: 0, parked: 0 });
    expect(replayed).toEqual(['k1', 'k2']);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('mixes sent, retried-failed and parked entries in one flush', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue({ ...BASE, idempotencyKey: 'k1' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k2' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k3' });
    await queue.enqueue({ ...BASE, idempotencyKey: 'k4' });

    const result = await queue.flush(async (request) => {
      if (request.idempotencyKey === 'k2') throw new Error('network down');
      if (request.idempotencyKey === 'k3') throw authError();
    });

    expect(result).toEqual({ sent: 1, failed: 1, parked: 2 });
    const remaining = (await queue.pending()).map((entry: QueuedRequest) => entry.idempotencyKey);
    expect(remaining).toEqual(['k2', 'k3', 'k4']);
  });
});
