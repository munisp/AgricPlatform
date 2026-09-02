import { describe, expect, it, vi } from 'vitest';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import {
  ProviderConfigError,
  ProviderRequestError
} from '../../modules/integrations/drivers/http.js';
import type { DomainEvent } from '../domain-events.service.js';
import {
  createEventBus,
  EVENT_BUS_CIRCUIT_THRESHOLD,
  type EventBus
} from './event-bus.driver.js';
import {
  FluvioEventBus,
  type FluvioClientLike,
  type FluvioProducerLike
} from './fluvio-event-bus.driver.js';

function sampleEvent(): DomainEvent {
  return {
    id: 'event-1',
    name: 'credit.loan.disbursed',
    payload: { loanId: 'loan-1' },
    occurredAt: new Date().toISOString()
  };
}

function fakeProducer(overrides: Partial<FluvioProducerLike> = {}) {
  const producer: FluvioProducerLike = {
    send: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  return producer;
}

function fakeClient(producer: FluvioProducerLike): FluvioClientLike {
  return {
    topicProducer: vi.fn().mockResolvedValue(producer),
    partitionConsumer: vi.fn()
  };
}

const FLUVIO_ENV: NodeJS.ProcessEnv = {
  EVENT_BUS_DRIVER: 'fluvio',
  FLUVIO_ENDPOINT: 'fluvio-sc:9003'
};

describe('createEventBus fluvio selection', () => {
  it('still defaults to the stub when EVENT_BUS_DRIVER is unset', () => {
    expect(createEventBus({}).name).toBe('stub');
  });

  it('fails closed when fluvio is selected without FLUVIO_ENDPOINT', () => {
    expect(() => createEventBus({ EVENT_BUS_DRIVER: 'fluvio' })).toThrow(ProviderConfigError);
    expect(() => createEventBus({ EVENT_BUS_DRIVER: 'fluvio', FLUVIO_ENDPOINT: ' ' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds the fluvio driver with the endpoint and topic prefix', () => {
    const bus = createEventBus(FLUVIO_ENV);
    expect(bus.name).toBe('fluvio');
    const prefixed = createEventBus({ ...FLUVIO_ENV, FLUVIO_TOPIC_PREFIX: 'events' });
    expect((prefixed as FluvioEventBus).topicFor('credit.loan.disbursed')).toBe(
      'events-credit-loan-disbursed'
    );
  });
});

describe('FluvioEventBus (EventBus port conformance)', () => {
  it('conforms to the EventBus port shape', () => {
    const bus: EventBus = new FluvioEventBus('localhost:9003');
    expect(bus.name).toBe('fluvio');
    expect(typeof bus.publish).toBe('function');
    expect(typeof bus.status).toBe('function');
    expect(typeof bus.close).toBe('function');
  });

  it('publishes the event as JSON keyed by event id to a Fluvio-safe topic', async () => {
    const producer = fakeProducer();
    const client = fakeClient(producer);
    const factory = vi.fn().mockResolvedValue(client);
    const bus = new FluvioEventBus('localhost:9003', { clientFactory: factory });
    const event = sampleEvent();
    await bus.publish(event);
    // Fluvio topic names allow only alphanumerics and dashes.
    expect(client.topicProducer).toHaveBeenCalledWith('agric-domain-credit-loan-disbursed');
    expect(producer.send).toHaveBeenCalledWith(event.id, JSON.stringify(event));
    expect(producer.flush).toHaveBeenCalledTimes(1);
  });

  it('connects the client lazily and caches producers per topic', async () => {
    const producer = fakeProducer();
    const client = fakeClient(producer);
    const factory = vi.fn().mockResolvedValue(client);
    const bus = new FluvioEventBus('localhost:9003', { clientFactory: factory });
    await bus.publish(sampleEvent());
    await bus.publish(sampleEvent());
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.topicProducer).toHaveBeenCalledTimes(1);
  });

  it('wraps send failures as ProviderRequestError (fail closed)', async () => {
    const producer = fakeProducer({ send: vi.fn().mockRejectedValue(new Error('spu down')) });
    const bus = new FluvioEventBus('localhost:9003', {
      clientFactory: () => Promise.resolve(fakeClient(producer))
    });
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('opens the circuit after consecutive failures and fails fast without sending', async () => {
    const producer = fakeProducer({ send: vi.fn().mockRejectedValue(new Error('spu down')) });
    const bus = new FluvioEventBus('localhost:9003', {
      clientFactory: () => Promise.resolve(fakeClient(producer))
    });
    for (let i = 0; i < EVENT_BUS_CIRCUIT_THRESHOLD; i += 1) {
      await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    }
    expect(bus.circuitOpen).toBe(true);
    const callsBefore = (producer.send as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    expect((producer.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('reconnects after a failure (client reference dropped, then rebuilt)', async () => {
    let fail = true;
    const producer = fakeProducer({
      send: vi.fn().mockImplementation(() => {
        if (fail) return Promise.reject(new Error('flaky'));
        return Promise.resolve(undefined);
      })
    });
    const factory = vi.fn().mockResolvedValue(fakeClient(producer));
    const bus = new FluvioEventBus('localhost:9003', { clientFactory: factory });
    await expect(bus.publish(sampleEvent())).rejects.toBeInstanceOf(ProviderRequestError);
    fail = false;
    await bus.publish(sampleEvent());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(bus.circuitOpen).toBe(false);
  });

  it('emits messaging.* spans and delivery counters with tenant attribution support', async () => {
    const producer = fakeProducer();
    const telemetry = new TelemetryService();
    const withSpan = vi.spyOn(telemetry, 'withSpan');
    const increment = vi.spyOn(telemetry, 'increment');
    const bus = new FluvioEventBus('localhost:9003', {
      clientFactory: () => Promise.resolve(fakeClient(producer)),
      telemetry
    });
    const event = sampleEvent();
    await bus.publish(event);
    expect(withSpan).toHaveBeenCalledWith(
      'fluvio.publish',
      expect.objectContaining({
        'messaging.system': 'fluvio',
        'messaging.destination.name': 'agric-domain-credit-loan-disbursed',
        'messaging.operation': 'publish',
        'messaging.message.id': event.id
      }),
      expect.any(Function)
    );
    expect(increment).toHaveBeenCalledWith(
      'eventbus.fluvio.deliveries.total',
      1,
      expect.objectContaining({ 'messaging.system': 'fluvio', result: 'ok' })
    );
  });

  it('streams consumed records and counts deliveries', async () => {
    const consumer = {
      stream: vi.fn().mockImplementation((_offset: unknown, cb: (r: unknown) => void) => {
        cb({ valueString: () => JSON.stringify(sampleEvent()) });
        return Promise.resolve();
      })
    };
    const client: FluvioClientLike = {
      topicProducer: vi.fn(),
      partitionConsumer: vi.fn().mockResolvedValue(consumer)
    };
    const telemetry = new TelemetryService();
    const increment = vi.spyOn(telemetry, 'increment');
    const bus = new FluvioEventBus('localhost:9003', {
      clientFactory: () => Promise.resolve(client),
      telemetry
    });
    const seen: unknown[] = [];
    await bus.consume('agric-domain-credit-loan-disbursed', (event) => seen.push(event));
    expect(seen).toHaveLength(1);
    expect((seen[0] as DomainEvent).name).toBe('credit.loan.disbursed');
    expect(increment).toHaveBeenCalledWith(
      'eventbus.fluvio.consumed.total',
      1,
      expect.objectContaining({ 'messaging.system': 'fluvio' })
    );
  });

  it('reports lazy-connect status honestly and close() is safe', async () => {
    const bus = new FluvioEventBus('localhost:9003');
    const before = await bus.status();
    expect(before.configured).toBe(true);
    expect(before.healthy).toBe(false);
    expect(before.detail).toContain('connects on first publish');
    await expect(bus.close()).resolves.toBeUndefined();
  });
});
