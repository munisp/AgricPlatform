import { describe, expect, it, vi } from 'vitest';
import { createInMemoryOutboxRepository } from '../database/repositories/outbox.repository.js';
import { createInMemoryProcessedEventRepository } from '../database/repositories/processed-event.repository.js';
import { DomainEventsService, type DomainEvent } from './domain-events.service.js';
import { EventDedupService } from './event-dedup.service.js';
import type { EventBus } from './events/event-bus.driver.js';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_SWEEP_MAX_PAGES,
  OutboxSweeperService
} from './outbox-sweeper.service.js';
import type { OutboxRecord, OutboxRepository } from '../database/repositories/outbox.repository.js';

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

describe('OutboxSweeperService redriveDeadLetter (V-79)', () => {
  it('resurrects a dead-lettered row: attempts cleared, re-published on next sweep', async () => {
    const outbox = createInMemoryOutboxRepository();
    const failingBus: EventBus = {
      name: 'kafka',
      publish: () => Promise.reject(new Error('broker down')),
      status: () =>
        Promise.resolve({ configured: true, healthy: false, detail: 'failing test bus' }),
      close: () => Promise.resolve()
    };
    const failingEvents = new DomainEventsService(outbox, failingBus);
    const deadSweeper = new OutboxSweeperService(failingEvents, outbox);
    const stalled = await seedStalled({ outbox, events: failingEvents, sweeper: deadSweeper });
    // Drive the row to the dead-letter cap: seed attempts just below it,
    // then one failing sweep past the backoff window dead-letters it.
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS - 1; i += 1) {
      await outbox.recordAttempt(stalled.id);
    }
    await deadSweeper.sweep(new Date(Date.now() + OUTBOX_RETRY_BASE_MS * 2 ** OUTBOX_MAX_ATTEMPTS));
    let record = (await outbox.listRecords()).find((row) => row.event.id === stalled.id);
    expect(record?.deadLetteredAt).toBeTruthy();
    expect(record?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);

    // Redrive: clears dead_lettered_at + attempts.
    const redriven = await deadSweeper.redriveDeadLetter(stalled.id);
    expect(redriven.event.id).toBe(stalled.id);
    record = (await outbox.listRecords()).find((row) => row.event.id === stalled.id);
    expect(record?.deadLetteredAt).toBeUndefined();
    expect(record?.attempts).toBe(0);

    // A working sweeper over the same outbox now delivers it.
    const { sweeper: liveSweeper } = build();
    const liveEvents = new DomainEventsService(outbox);
    const healthySweeper = new OutboxSweeperService(liveEvents, outbox);
    void liveSweeper;
    expect((await healthySweeper.sweep()).published).toBe(1);
    record = (await outbox.listRecords()).find((row) => row.event.id === stalled.id);
    expect(record?.publishedAt).toBeTruthy();
  });

  it('404s for rows that are not dead-lettered (or missing)', async () => {
    const { sweeper, events, outbox } = build();
    const stalled = await seedStalled({ events, sweeper, outbox });
    await expect(sweeper.redriveDeadLetter(stalled.id)).rejects.toThrowError(/dead-lettered/);
    await expect(sweeper.redriveDeadLetter('event-missing')).rejects.toThrowError(/dead-lettered/);
  });
});

describe('OutboxSweeperService consumer-side dedup (GAP-M09)', () => {
  it('a dedup-guarded listener does not re-execute on a sweeper re-drive', async () => {
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
    const sweeper = new OutboxSweeperService(events, outbox);
    const handled: string[] = [];
    events.on('advisory.content.published', (event) => {
      void dedup.runOnce('spec-listener', event.id, () => {
        handled.push(event.id);
      });
    });

    // First delivery: a stalled row is relayed and the guarded handler runs.
    const stalled = await seedStalled({ outbox, events, sweeper });
    expect((await sweeper.sweep()).published).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual([stalled.id]);

    // Re-drive: force the row unpublished again (GAP-M10 crashed-mark
    // scenario). The sweeper re-emits the event through the fan-out, but
    // the processed_events record makes the guarded listener skip the
    // duplicate instead of re-executing the side effect.
    // markPublished(id, undefined) clears the published marker in the
    // in-memory repo, so the next sweep treats the row as stalled again.
    await outbox.markPublished(stalled.id, undefined as unknown as string);
    expect((await sweeper.sweep()).published).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toEqual([stalled.id]);
  });
});

describe('OutboxSweeperService paged drain (GAP-L03)', () => {
  /** OutboxRepository delegating wrapper whose list reads are capped at pageSize. */
  function pagedRepo(
    underlying: ReturnType<typeof createInMemoryOutboxRepository>,
    pageSize: number
  ): OutboxRepository {
    return {
      append: (event) => underlying.append(event),
      list: () => underlying.list(pageSize),
      listRecords: (): Promise<OutboxRecord[]> => underlying.listRecords(pageSize),
      listPendingRecords: (_limit, offset): Promise<OutboxRecord[]> =>
        underlying.listPendingRecords(pageSize, offset),
      markPublished: (id, publishedAt) => underlying.markPublished(id, publishedAt),
      recordAttempt: (id) => underlying.recordAttempt(id),
      markDeadLetter: (id, deadLetteredAt) => underlying.markDeadLetter(id, deadLetteredAt),
      resetDeadLetter: (id) => underlying.resetDeadLetter(id),
      countPublishedBefore: (cutoff) => underlying.countPublishedBefore(cutoff),
      anonymizePublishedBefore: (cutoff) => underlying.anonymizePublishedBefore(cutoff),
      purgePublishedBefore: (cutoff) => underlying.purgePublishedBefore(cutoff),
      countDeadLetteredBefore: (cutoff) => underlying.countDeadLetteredBefore(cutoff),
      anonymizeDeadLetteredBefore: (cutoff) => underlying.anonymizeDeadLetteredBefore(cutoff),
      purgeDeadLetteredBefore: (cutoff) => underlying.purgeDeadLetteredBefore(cutoff)
    };
  }

  function buildPaged(pageSize: number) {
    const inner = createInMemoryOutboxRepository();
    const outbox = pagedRepo(inner, pageSize);
    const events = new DomainEventsService(outbox);
    const sweeper = new OutboxSweeperService(events, outbox);
    return { inner, outbox, events, sweeper };
  }

  async function seedMany(
    outbox: OutboxRepository,
    count: number
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await outbox.append({
        id: `event-paged-${i}`,
        name: 'advisory.content.published',
        payload: { i },
        occurredAt: new Date().toISOString()
      });
    }
  }

  it('drains beyond the first repository page in one sweep', async () => {
    const { sweeper, inner } = buildPaged(5);
    await seedMany(inner, 12);
    const result = await sweeper.sweep();
    expect(result.published).toBe(12);
    expect((await inner.listRecords()).every((row) => row.publishedAt)).toBe(true);
  });

  it('bounds one pass at OUTBOX_SWEEP_MAX_PAGES pages; the rest drains next pass', async () => {
    const { sweeper, inner } = buildPaged(5);
    await seedMany(inner, OUTBOX_SWEEP_MAX_PAGES * 5 + 3);
    const first = await sweeper.sweep();
    expect(first.published).toBe(OUTBOX_SWEEP_MAX_PAGES * 5);
    const second = await sweeper.sweep();
    expect(second.published).toBe(3);
    expect((await sweeper.sweep()).published).toBe(0);
  });

  it('does not retry a failed row multiple times within one pass', async () => {
    const { inner, events, sweeper } = buildPaged(5);
    events.on('advisory.content.published', () => {
      throw new Error('listener exploded');
    });
    await seedMany(inner, 3);
    const result = await sweeper.sweep(new Date());
    expect(result.failed).toBe(3);
    const records = await inner.listRecords();
    expect(records.map((row) => row.attempts)).toEqual([1, 1, 1]);
  });

  it('stops early when a whole page is deferred (no livelock on backoff)', async () => {
    const { inner, events, sweeper } = buildPaged(5);
    events.on('advisory.content.published', () => {
      throw new Error('listener exploded');
    });
    await seedMany(inner, 7);
    const now = new Date();
    expect((await sweeper.sweep(now)).failed).toBe(7);
    // All seven rows are now inside their backoff window: the second sweep
    // sees a no-change first page and stops instead of looping pages.
    const again = await sweeper.sweep(now);
    expect(again).toEqual({ published: 0, failed: 0, deadLettered: 0, deferred: 7 });
  });
});
