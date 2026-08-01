import { describe, expect, it, vi } from 'vitest';
import {
  createQueueItem,
  flushQueue,
  markFailed,
  markSending,
  markSent,
  normalizeQueueItem
} from '@/lib/offline-queue';
import type { QueuedSubmission } from '@/lib/offline-queue';

function item(overrides: Partial<QueuedSubmission> = {}): QueuedSubmission {
  return createQueueItem({
    kind: 'order.place',
    label: 'Order: cassava',
    method: 'POST',
    path: '/listings/l1/orders',
    payload: { buyerId: 'user-buyer', quantity: 2 },
    ...overrides
  });
}

describe('createQueueItem', () => {
  it('captures replay data with an idempotency key and queued status', () => {
    const queued = item();
    expect(queued.status).toBe('queued');
    expect(queued.attempts).toBe(0);
    expect(queued.idempotencyKey).toMatch(/.+/);
    expect(queued.method).toBe('POST');
    expect(queued.path).toBe('/listings/l1/orders');
    expect(queued.createdAt).toMatch(/T/);
  });

  it('preserves a provided idempotency key', () => {
    expect(item({ idempotencyKey: 'keep-me' }).idempotencyKey).toBe('keep-me');
  });
});

describe('normalizeQueueItem', () => {
  it('passes through well-formed items and demotes stale sending states', () => {
    const sending = { ...item(), status: 'sending' as const };
    expect(normalizeQueueItem(sending)?.status).toBe('queued');
    const sent = { ...item(), status: 'sent' as const, attempts: 1 };
    expect(normalizeQueueItem(sent)?.status).toBe('sent');
  });

  it('migrates legacy display-only entries to non-replayable failed items', () => {
    const legacy = {
      id: 'queue-1',
      kind: 'opportunity.application.submitted',
      label: 'Application: grant',
      createdAt: '2026-08-01T00:00:00.000Z',
      status: 'queued'
    };
    const migrated = normalizeQueueItem(legacy);
    expect(migrated?.status).toBe('failed');
    expect(migrated?.path).toBe('');
    expect(migrated?.lastError).toMatch(/earlier app version/);
  });

  it('drops garbage', () => {
    expect(normalizeQueueItem(null)).toBeNull();
    expect(normalizeQueueItem({ label: 3 })).toBeNull();
  });
});

describe('status transitions', () => {
  it('markSending/markSent/markFailed update only the targeted item', () => {
    const a = item({ id: 'a' });
    const b = item({ id: 'b' });
    let queue = [a, b];
    queue = markSending(queue, 'a');
    expect(queue[0].status).toBe('sending');
    expect(queue[1].status).toBe('queued');
    queue = markSent(queue, 'a');
    expect(queue[0].status).toBe('sent');
    expect(queue[0].attempts).toBe(1);
    queue = markFailed(queue, 'b', 'HTTP 500');
    expect(queue[1].status).toBe('failed');
    expect(queue[1].lastError).toBe('HTTP 500');
    expect(queue[1].attempts).toBe(1);
  });
});

describe('flushQueue', () => {
  it('sends queued items in order with their stored payloads', async () => {
    const calls: string[] = [];
    const send = vi.fn(async (queued: QueuedSubmission) => {
      calls.push(`${queued.method} ${queued.path} key=${queued.idempotencyKey}`);
    });
    const first = item({ id: '1' });
    const second = item({ id: '2', path: '/community/topics' });
    const result = await flushQueue([first, second], send);
    expect(result.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(calls).toEqual([
      `POST /listings/l1/orders key=${first.idempotencyKey}`,
      `POST /community/topics key=${second.idempotencyKey}`
    ]);
  });

  it('marks failures and continues with the remaining items', async () => {
    const send = vi.fn(async (queued: QueuedSubmission) => {
      if (queued.id === 'bad') throw new Error('HTTP 503');
    });
    const result = await flushQueue([item({ id: 'bad' }), item({ id: 'good' })], send);
    expect(result[0].status).toBe('failed');
    expect(result[0].lastError).toBe('HTTP 503');
    expect(result[1].status).toBe('sent');
  });

  it('skips already-sent and non-replayable legacy items', async () => {
    const send = vi.fn(async () => {});
    const legacy = normalizeQueueItem({
      id: 'legacy-1',
      kind: 'legacy',
      label: 'old',
      createdAt: '2026-01-01T00:00:00.000Z'
    })!;
    const sent = { ...item({ id: 'done' }), status: 'sent' as const };
    const result = await flushQueue([legacy, sent], send);
    expect(send).not.toHaveBeenCalled();
    expect(result[0].status).toBe('failed');
    expect(result[1].status).toBe('sent');
  });
});
