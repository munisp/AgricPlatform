import { describe, expect, it } from 'vitest';
import { createInMemoryStorage, createOfflineQueue, type QueuedRequest } from '../src/offline/queue';

const SAMPLE = {
  kind: 'services.booking.created',
  method: 'POST' as const,
  path: '/service-offerings/offering-1/bookings',
  payload: { customerId: 'user-1', quantity: 1 },
  idempotencyKey: 'idem-1'
};

describe('offline mutation queue', () => {
  it('enqueues with an id + timestamp and lists pending requests', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    const queued = await queue.enqueue(SAMPLE);
    expect(queued.id).toBeTruthy();
    expect(queued.enqueuedAt).toBeTruthy();
    expect(queued.idempotencyKey).toBe('idem-1');
    expect(await queue.pending()).toHaveLength(1);
  });

  it('survives a restart (same storage, new queue instance)', async () => {
    const storage = createInMemoryStorage();
    await createOfflineQueue(storage).enqueue(SAMPLE);
    const reopened = createOfflineQueue(storage);
    expect(await reopened.pending()).toHaveLength(1);
  });

  it('flush replays queued requests in order and clears the successful ones', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue(SAMPLE);
    await queue.enqueue({ ...SAMPLE, idempotencyKey: 'idem-2', path: '/pathway-enrolments/e-1/complete-stage' });

    const sent: QueuedRequest[] = [];
    const result = await queue.flush(async (request) => {
      sent.push(request);
    });
    expect(result).toEqual({ sent: 2, failed: 0, parked: 0 });
    expect(sent.map((request) => request.idempotencyKey)).toEqual(['idem-1', 'idem-2']);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('flush keeps failed requests queued for the next replay', async () => {
    const queue = createOfflineQueue(createInMemoryStorage());
    await queue.enqueue(SAMPLE);
    await queue.enqueue({ ...SAMPLE, idempotencyKey: 'idem-2' });

    let calls = 0;
    const result = await queue.flush(async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
    });
    expect(result).toEqual({ sent: 1, failed: 1, parked: 0 });
    const remaining = await queue.pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].idempotencyKey).toBe('idem-1');
  });
});
