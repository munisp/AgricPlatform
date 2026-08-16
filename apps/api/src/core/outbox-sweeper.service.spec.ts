import { describe, expect, it, vi } from 'vitest';
import { createInMemoryOutboxRepository } from '../database/repositories/outbox.repository.js';
import { createInMemoryProcessedEventRepository } from '../database/repositories/processed-event.repository.js';
import { DomainEventsService, type DomainEvent } from './domain-events.service.js';
import { EventDedupService } from './event-dedup.service.js';
import type { EventBus } from './events/event-bus.driver.js';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BASE_MS,
  OutboxSweeperService
} from './outbox-sweeper.service.js';

function build() {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const sweeper = new OutboxSweeperService(events, outbox);
  return { outbox, events, sweeper };
}

let seq = 0;
/** A stalled outbox row: persisted but never relayed (published_at NULL). */
async function seedStalled(
  deps: ReturnType<typeof build>,
  occurredAt = new Date().toISOString()
): Promise<DomainEvent> {
  seq += 1;
  const event: DomainEvent = {
    id: `event-stalled-${seq}`,
    name: 'advisory.content.published',
    payload: { advisoryId: `a${seq}` },
    occurredAt
  };
  await deps.outbox.append(event);
  return event;
}

describe('OutboxSweeperService', () => {
  it('backoff doubles per attempt from the base delay', () => {
    const { sweeper } = build();
    expect(sweeper.backoffMs(1)).toBe(OUTBOX_RETRY_BASE_MS);
    expect(sweeper.backoffMs(2)).toBe(OUTBOX_RETRY_BASE_MS * 2);
    expect(sweeper.backoffMs(4)).toBe(OUTBOX_RETRY_BASE_MS * 8);
  });

  it('marks rows published during normal fan-out so sweeps skip them', async () => {
    const { events, sweeper, outbox } = build();
    await events.publish('advisory.content.published', { advisoryId: 'live' });
    const records = await outbox.listRecords();
    expect(records[0].publishedAt).toBeTruthy();
    expect((await sweeper.sweep()).published).toBe(0);
  });

  it('publishes stalled rows on sweep and re-emits them once', async () => {
    const deps = build();
    const seen: string[] = [];
    deps.events.on('advisory.content.published', (event) => seen.push(event.id));
    const event = await seedStalled(deps);

    const result = await deps.sweeper.sweep();
    expect(result.published).toBe(1);
    expect(seen).toEqual([event.id]);
    expect((await deps.outbox.listRecords())[0].publishedAt).toBeTruthy();

    // A second sweep does not republish.
    expect((await deps.sweeper.sweep()).published).toBe(0);
    expect(seen).toEqual([event.id]);
  });

  it('defers failed rows until the backoff window elapses', async () => {
    const deps = build();
    deps.events.on('advisory.content.published', () => {
      throw new Error('listener exploded');
    });
    const event = await seedStalled(deps);

    const first = await deps.sweeper.sweep(new Date());
    expect(first.failed).toBe(1);
    expect((await deps.outbox.listRecords())[0].attempts).toBe(1);

    // Immediately after: still inside the backoff window.
    const deferred = await deps.sweeper.sweep(new Date(Date.now() + OUTBOX_RETRY_BASE_MS / 2));
    expect(deferred.deferred).toBe(1);
    expect(deferred.failed).toBe(0);

    // After the window: retried.
    const later = await deps.sweeper.sweep(
      new Date(new Date(event.occurredAt).getTime() + OUTBOX_RETRY_BASE_MS + 1)
    );
    expect(later.failed).toBe(1);
    expect((await deps.outbox.listRecords())[0].attempts).toBe(2);
  });

  it('dead-letters after max attempts and excludes dead rows from sweeps', async () => {
    const deps = build();
    deps.events.on('advisory.content.published', () => {
      throw new Error('always fails');
    });
    const event = await seedStalled(deps);
    // Seed attempts just below the cap.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i += 1) {
      await deps.outbox.recordAttempt(event.id);
    }
    const result = await deps.sweeper.sweep(
      new Date(Date.now() + OUTBOX_RETRY_BASE_MS * 2 ** OUTBOX_MAX_ATTEMPTS)
    );
    expect(result.deadLettered).toBe(1);
    const records = await deps.outbox.listRecords();
    expect(records[0].deadLetteredAt).toBeTruthy();

    const again = await deps.sweeper.sweep(
      new Date(Date.now() + OUTBOX_RETRY_BASE_MS * 2 ** (OUTBOX_MAX_ATTEMPTS + 1))
    );
    expect(again).toEqual({ published: 0, failed: 0, deadLettered: 0, deferred: 0 });
    expect((await deps.sweeper.deadLetters()).map((record) => record.event.id)).toEqual([event.id]);
  });

  it('reports backlog for health probes', async () => {
    const deps = build();
    await seedStalled(deps);
    expect(await deps.sweeper.backlog()).toEqual({ pending: 1, deadLettered: 0 });
    await deps.sweeper.sweep();
    expect(await deps.sweeper.backlog()).toEqual({ pending: 0, deadLettered: 0 });
  });

  // Audit C2: the sweeper must mark a row published ONLY after the event
  // bus accepts it — the old fire-and-forget path lost broker-rejected
  // events while claiming they were relayed.
  describe('with a live event bus', () => {
    function buildWithBus(publish: EventBus['publish']) {
      const outbox = createInMemoryOutboxRepository();
      const bus: EventBus = {
        name: 'kafka',
        publish,
        status: async () => ({ configured: true, healthy: true, detail: 'fake' }),
        close: async () => undefined
      };
      const events = new DomainEventsService(outbox, bus);
      const sweeper = new OutboxSweeperService(events, outbox);
      return { bus, events, outbox, sweeper };
    }

    it('does NOT mark the row published when the bus rejects it; attempts are recorded', async () => {
      const publish = vi.fn().mockRejectedValue(new Error('broker unavailable'));
      const deps = buildWithBus(publish);
      const seen: string[] = [];
      deps.events.on('advisory.content.published', (event) => seen.push(event.id));
      const event = await seedStalled(deps);

      const result = await deps.sweeper.sweep();
      expect(result).toMatchObject({ published: 0, failed: 1 });
      expect(publish).toHaveBeenCalledTimes(1);
      const record = (await deps.outbox.listRecords())[0];
      expect(record.publishedAt).toBeUndefined();
      expect(record.attempts).toBe(1);
      // Bus-first ordering: local fan-out is deferred to the retry.
      expect(seen).toEqual([]);

      // Backoff defers the immediate retry; after the window the row is
      // retried and (bus now healthy) marked published.
      publish.mockResolvedValue(undefined);
      const later = new Date(new Date(event.occurredAt).getTime() + OUTBOX_RETRY_BASE_MS + 1);
      const retry = await deps.sweeper.sweep(later);
      expect(retry.published).toBe(1);
      expect((await deps.outbox.listRecords())[0].publishedAt).toBeTruthy();
      expect(seen).toEqual([event.id]);
    });

    it('marks the row published after the bus accepts it', async () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      const deps = buildWithBus(publish);
      const seen: string[] = [];
      deps.events.on('advisory.content.published', (event) => seen.push(event.id));
      const event = await seedStalled(deps);

      const result = await deps.sweeper.sweep();
      expect(result).toMatchObject({ published: 1, failed: 0 });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0].id).toBe(event.id);
      expect(seen).toEqual([event.id]);
      expect((await deps.outbox.listRecords())[0].publishedAt).toBeTruthy();
    });
  });
});

describe('EventDedupService (events.processed_events)', () => {
  it('first delivery passes, redelivery is ignored', async () => {
    const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
    expect(await dedup.once('consumer-a', 'event-1')).toBe(true);
    expect(await dedup.once('consumer-a', 'event-1')).toBe(false);
  });

  it('dedup is scoped per consumer', async () => {
    const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
    expect(await dedup.once('consumer-a', 'event-1')).toBe(true);
    expect(await dedup.once('consumer-b', 'event-1')).toBe(true);
  });

  it('makes sweeper redelivery idempotent for a dedup-aware listener', async () => {
    const deps = build();
    const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
    const handled: string[] = [];
    const handler = vi.fn(async (eventId: string) => {
      if (await dedup.once('listener-x', eventId)) {
        handled.push(eventId);
      }
    });
    deps.events.on('advisory.content.published', (event) => {
      void handler(event.id);
    });
    const event = await seedStalled(deps);
    await deps.sweeper.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual([event.id]);
  });
});
