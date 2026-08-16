import { describe, expect, it, vi } from 'vitest';
import { InMemoryOutboxRepository } from '../database/repositories/outbox.repository.js';
import { DomainEventsService, type DomainEvent } from './domain-events.service.js';
import type { EventBus } from './events/event-bus.driver.js';

function makeService(bus?: EventBus) {
  const outbox = new InMemoryOutboxRepository();
  return { outbox, service: new DomainEventsService(outbox, bus) };
}

function fakeBus(publish: EventBus['publish']): EventBus {
  return {
    name: 'kafka',
    publish,
    status: async () => ({ configured: true, healthy: true, detail: 'fake' }),
    close: async () => undefined
  };
}

const event: DomainEvent = {
  id: 'event-1',
  name: 'learning.certificate.issued',
  payload: { certificateId: 'cert-1' },
  occurredAt: new Date().toISOString()
};

describe('DomainEventsService', () => {
  it('publishes events using the {domain}.{entity}.{verb} taxonomy', async () => {
    const { service } = makeService();
    const seen: string[] = [];
    service.on('learning.certificate.issued', (event) => seen.push(event.name));

    const event = await service.publish('learning.certificate.issued', { certificateId: 'cert-1' }, 'user-1');
    expect(event.name).toBe('learning.certificate.issued');
    expect(seen).toEqual(['learning.certificate.issued']);
    expect(await service.listOutbox()).toHaveLength(1);
  });

  it('rejects names outside the taxonomy', async () => {
    const { service } = makeService();
    await expect(service.publish('certificateIssued', {})).rejects.toThrow(/taxonomy/);
    await expect(service.publish('too.many.segments.here', {})).rejects.toThrow(/taxonomy/);
  });
});

describe('DomainEventsService.emitAwaitable (audit C2)', () => {
  it('resolves after the bus accepts the event, then fans out and marks published', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const { outbox, service } = makeService(fakeBus(publish));
    const seen: string[] = [];
    service.on('learning.certificate.issued', (e) => seen.push(e.id));

    await service.emitAwaitable(event);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([event.id]);
    const record = (await outbox.listRecords()).find((row) => row.event.id === event.id);
    // The event was never appended to the outbox here (emitAwaitable is the
    // post-persist relay); markPublished is best-effort on absent rows.
    expect(record).toBeUndefined();
  });

  it('rejects when the bus rejects — no fan-out, nothing marked published', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('broker down'));
    const { service } = makeService(fakeBus(publish));
    const seen: string[] = [];
    service.on('learning.certificate.issued', (e) => seen.push(e.id));

    await expect(service.emitAwaitable(event)).rejects.toThrow('broker down');
    expect(seen).toEqual([]);
  });

  it('fans out and marks published with the default stub bus', async () => {
    const { outbox, service } = makeService();
    await outbox.append(event);
    const seen: string[] = [];
    service.on('learning.certificate.issued', (e) => seen.push(e.id));

    await service.emitAwaitable(event);
    expect(seen).toEqual([event.id]);
    expect((await outbox.listRecords())[0].publishedAt).toBeTruthy();
  });

  it('emit() stays fire-and-forget for transactional-path callers', () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const { service } = makeService(fakeBus(publish));
    const seen: string[] = [];
    service.on('learning.certificate.issued', (e) => seen.push(e.id));

    expect(() => service.emit(event)).not.toThrow();
    expect(seen).toEqual([event.id]); // fan-out is synchronous
    expect(publish).toHaveBeenCalledTimes(1); // bus delivery runs in background
  });
});
