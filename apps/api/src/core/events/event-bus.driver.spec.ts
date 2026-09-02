import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConfigError,
  ProviderRequestError
} from '../../modules/integrations/drivers/http.js';
import { DomainEventsService, type DomainEvent } from '../domain-events.service.js';
import {
  createEventBus,
  EVENT_BUS_CIRCUIT_THRESHOLD,
  KafkaEventBus,
  StubEventBus,
  type KafkaProducerLike
} from './event-bus.driver.js';

function sampleEvent(): DomainEvent {
  return {
    id: 'event-1',
    name: 'credit.loan.disbursed',
    payload: { loanId: 'loan-1' },
    occurredAt: new Date().toISOString()
  };
}

function fakeProducer(overrides: Partial<KafkaProducerLike> = {}) {
  const producer: KafkaProducerLike = {
    connect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  return producer;
}

describe('StubEventBus (default — current in-process behaviour)', () => {
  const bus = new StubEventBus();

  it('is a labelled no-op', async () => {
    expect(bus.name).toBe('stub');
    await expect(bus.publish(sampleEvent())).resolves.toBeUndefined();
    await expect(bus.close()).resolves.toBeUndefined();
  });

  it('reports the in-process transport honestly', async () => {
    const status = await bus.status();
    expect(status.healthy).toBe(true);
    expect(status.detail).toContain('Stub driver');
    expect(status.detail).toContain('EVENT_BUS_DRIVER=kafka');
  });
});

describe('createEventBus selection', () => {
  it('defaults to the stub when EVENT_BUS_DRIVER is unset', () => {
    expect(createEventBus({}).name).toBe('stub');
  });

  it('fails closed when kafka is selected without KAFKA_BROKERS', () => {
    expect(() => createEventBus({ EVENT_BUS_DRIVER: 'kafka' })).toThrow(ProviderConfigError);
    expect(() => createEventBus({ EVENT_BUS_DRIVER: 'kafka', KAFKA_BROKERS: '  ' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds the kafka driver with parsed brokers and topic prefix', () => {
    const bus = createEventBus({
      EVENT_BUS_DRIVER: 'kafka',
      KAFKA_BROKERS: 'localhost:9092, redpanda:9092'
    });
    expect(bus.name).toBe('kafka');
    expect((bus as KafkaEventBus).topicFor('credit.loan.disbursed')).toBe(
      'agric.domain.credit.loan.disbursed'
    );
    const prefixed = createEventBus({
      EVENT_BUS_DRIVER: 'kafka',
      KAFKA_BROKERS: 'localhost:9092',
      KAFKA_TOPIC_PREFIX: 'events'
    });
    expect((prefixed as KafkaEventBus).topicFor('credit.loan.disbursed')).toBe(
      'events.credit.loan.disbursed'
    );
  });
});

describe('KafkaEventBus', () => {
  it('publishes the event as JSON to the taxonomy topic, keyed by event id', async () => {
    const producer = fakeProducer();
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () => Promise.resolve(producer)
    });
    const event = sampleEvent();
    await bus.publish(event);
    expect(producer.connect).toHaveBeenCalledTimes(1);
    expect(producer.send).toHaveBeenCalledWith({
      topic: 'agric.domain.credit.loan.disbursed',
      messages: [{ key: event.id, value: JSON.stringify(event) }]
    });
  });

  it('connects the producer lazily and only once', async () => {
    const producer = fakeProducer();
    const factory = vi.fn().mockResolvedValue(producer);
    const bus = new KafkaEventBus(['localhost:9092'], { producerFactory: factory });
    await bus.publish(sampleEvent());
    await bus.publish(sampleEvent());
    expect(factory).toHaveBeenCalledTimes(1);
    expect(producer.connect).toHaveBeenCalledTimes(1);
  });

  it('wraps send failures as ProviderRequestError (fail closed)', async () => {
    const producer = fakeProducer({ send: vi.fn().mockRejectedValue(new Error('broker down')) });
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () => Promise.resolve(producer)
    });
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('opens the circuit after consecutive failures and fails fast without sending', async () => {
    const producer = fakeProducer({ send: vi.fn().mockRejectedValue(new Error('broker down')) });
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () => Promise.resolve(producer)
    });
    for (let i = 0; i < EVENT_BUS_CIRCUIT_THRESHOLD; i += 1) {
      await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    }
    expect(bus.circuitOpen).toBe(true);
    const callsBefore = (producer.send as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    expect((producer.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('resets the failure count after a successful publish', async () => {
    let fail = true;
    const producer = fakeProducer({
      send: vi.fn().mockImplementation(() => {
        if (fail) return Promise.reject(new Error('flaky'));
        return Promise.resolve(undefined);
      })
    });
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () => Promise.resolve(producer)
    });
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    fail = false;
    await bus.publish(sampleEvent());
    fail = true;
    // One more failure must not open the circuit (counter was reset).
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    expect(bus.circuitOpen).toBe(false);
  });
});

describe('DomainEventsService event-bus integration', () => {
  function fakeOutbox() {
    return {
      append: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      markPublished: vi.fn().mockResolvedValue(undefined)
    };
  }

  it('publishes to a live bus after the outbox append on persist()', async () => {
    const outbox = fakeOutbox();
    const bus = { name: 'kafka' as const, publish: vi.fn().mockResolvedValue(undefined) };
    const service = new DomainEventsService(outbox as never, bus as never);
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    await service.persist(event);
    expect(outbox.append).toHaveBeenCalledWith(event);
    expect(bus.publish).toHaveBeenCalledWith(event);
  });

  it('fails closed: a live-bus failure propagates but the outbox row remains', async () => {
    const outbox = fakeOutbox();
    const bus = {
      name: 'kafka' as const,
      publish: vi.fn().mockRejectedValue(new ProviderRequestError('kafka', 'network'))
    };
    const service = new DomainEventsService(outbox as never, bus as never);
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    await expect(service.persist(event)).rejects.toBeInstanceOf(ProviderRequestError);
    expect(outbox.append).toHaveBeenCalledWith(event);
  });

  it('keeps default behaviour with the stub bus (fan-out only, no publish)', async () => {
    const outbox = fakeOutbox();
    const service = new DomainEventsService(outbox as never, new StubEventBus());
    const seen: DomainEvent[] = [];
    service.on('credit.loan.disbursed', (event) => seen.push(event));
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    await service.persist(event);
    expect(outbox.append).toHaveBeenCalledWith(event);
    expect(seen).toEqual([event]);
  });

  it('treats emit() bus delivery as best-effort (post-commit, never throws)', async () => {
    const outbox = fakeOutbox();
    const bus = {
      name: 'kafka' as const,
      publish: vi.fn().mockRejectedValue(new Error('broker down'))
    };
    const service = new DomainEventsService(outbox as never, bus as never);
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    expect(() => service.emit(event)).not.toThrow();
    await vi.waitFor(() => expect(bus.publish).toHaveBeenCalledWith(event));
  });

  it('emit() marks the outbox row published only after the bus accepts the event', async () => {
    const outbox = fakeOutbox();
    const bus = { name: 'kafka' as const, publish: vi.fn().mockResolvedValue(undefined) };
    const service = new DomainEventsService(outbox as never, bus as never);
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    service.emit(event);
    await vi.waitFor(() => expect(outbox.markPublished).toHaveBeenCalledWith(event.id, expect.any(String)));
  });

  it('emit() leaves the outbox row unpublished when the bus fails (sweeper retries)', async () => {
    const outbox = fakeOutbox();
    const bus = {
      name: 'kafka' as const,
      publish: vi.fn().mockRejectedValue(new Error('broker down'))
    };
    const service = new DomainEventsService(outbox as never, bus as never);
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    service.emit(event);
    // Let the rejected publish promise settle; the row must stay unpublished.
    await vi.waitFor(() => expect(bus.publish).toHaveBeenCalledWith(event));
    await new Promise((resolve) => setImmediate(resolve));
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });

  it('emit() still fans out in-process listeners when the bus fails', async () => {
    const outbox = fakeOutbox();
    const bus = {
      name: 'kafka' as const,
      publish: vi.fn().mockRejectedValue(new Error('broker down'))
    };
    const service = new DomainEventsService(outbox as never, bus as never);
    const seen: DomainEvent[] = [];
    service.on('credit.loan.disbursed', (event) => seen.push(event));
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    service.emit(event);
    expect(seen).toEqual([event]);
    await vi.waitFor(() => expect(bus.publish).toHaveBeenCalledWith(event));
    await new Promise((resolve) => setImmediate(resolve));
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });
});

/** Records TelemetryService calls; withSpan executes fn like the real thing. */
function fakeTelemetry() {
  return {
    withSpan: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()),
    increment: vi.fn(),
    record: vi.fn()
  };
}

describe('KafkaEventBus telemetry (Stage 25.2)', () => {
  it('wraps publish in a span with messaging.* attrs and records duration', async () => {
    const telemetry = fakeTelemetry();
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () => Promise.resolve(fakeProducer()),
      telemetry: telemetry as never
    });
    await bus.publish(sampleEvent());
    expect(telemetry.withSpan).toHaveBeenCalledWith(
      'event-bus.publish',
      expect.objectContaining({
        'messaging.system': 'kafka',
        'messaging.operation.name': 'publish',
        'messaging.destination.name': 'agric.domain.credit.loan.disbursed',
        'messaging.event.name': 'credit.loan.disbursed'
      }),
      expect.any(Function)
    );
    // Event payload (tenant data) must never appear in span attributes.
    const attrs = telemetry.withSpan.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(attrs)).not.toContain('loan-1');
    expect(telemetry.record).toHaveBeenCalledWith(
      'event-bus.publish.duration',
      expect.any(Number),
      expect.objectContaining({ 'messaging.system': 'kafka' })
    );
  });

  it('counts publish failures and still throws ProviderRequestError', async () => {
    const telemetry = fakeTelemetry();
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () =>
        Promise.resolve(fakeProducer({ send: vi.fn().mockRejectedValue(new Error('down')) })),
      telemetry: telemetry as never
    });
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    expect(telemetry.increment).toHaveBeenCalledWith(
      'event-bus.publish.errors',
      1,
      expect.objectContaining({ 'messaging.system': 'kafka' })
    );
  });

  it('is no-op-safe without an injected TelemetryService (default fallback)', async () => {
    const bus = new KafkaEventBus(['localhost:9092'], {
      producerFactory: () => Promise.resolve(fakeProducer())
    });
    await expect(bus.publish(sampleEvent())).resolves.toBeUndefined();
  });
});

describe('DomainEventsService consumer-handler telemetry (Stage 25.2)', () => {
  function fakeOutbox() {
    return {
      append: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      markPublished: vi.fn().mockResolvedValue(undefined)
    };
  }

  it('wraps the listener fan-out in a consumer span and records duration', async () => {
    const telemetry = fakeTelemetry();
    const service = new DomainEventsService(fakeOutbox() as never, undefined, telemetry as never);
    const seen: DomainEvent[] = [];
    service.on('credit.loan.disbursed', (event) => seen.push(event));
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    await service.persist(event);
    expect(seen).toEqual([event]);
    expect(telemetry.withSpan).toHaveBeenCalledWith(
      'eventbus.handler',
      expect.objectContaining({
        'messaging.operation.name': 'process',
        'messaging.event.name': 'credit.loan.disbursed'
      }),
      expect.any(Function)
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      'eventbus.handler.duration',
      expect.any(Number),
      expect.objectContaining({ 'messaging.event.name': 'credit.loan.disbursed' })
    );
  });

  it('counts listener failures and preserves throwing-listener semantics', async () => {
    const telemetry = fakeTelemetry();
    const service = new DomainEventsService(fakeOutbox() as never, undefined, telemetry as never);
    service.on('credit.loan.disbursed', () => {
      throw new Error('listener boom');
    });
    const event = service.build('credit.loan.disbursed', { loanId: 'loan-1' });
    await expect(service.persist(event)).rejects.toThrow('listener boom');
    expect(telemetry.increment).toHaveBeenCalledWith(
      'eventbus.handler.failures',
      1,
      expect.objectContaining({ 'messaging.event.name': 'credit.loan.disbursed' })
    );
  });
});
