/**
 * Fluvio event-bus driver (Stage 25 / wave W2): the same EventBus port as
 * the kafkajs driver (event-bus.driver.ts), backed by a Fluvio cluster via
 * the official `@fluvio/client` native Node binding. Selected with
 * EVENT_BUS_DRIVER=fluvio; requires FLUVIO_ENDPOINT (host:port) and fails
 * closed with ProviderConfigError at factory time when it is absent —
 * mirroring the kafka driver, never a silent fallback to the stub.
 *
 * Topic naming: Fluvio topic names allow only alphanumerics and dashes, so
 * the `{prefix}.{event.name}` taxonomy is mapped to dashes
 * (`agric.domain` + `credit.loan.disbursed` → `agric-domain-credit-loan-disbursed`).
 * Set FLUVIO_TOPIC_PREFIX to override the default `agric.domain` prefix.
 *
 * Client notes: the native binding is imported lazily (only when the driver
 * is selected), mirroring the kafka driver's lazy kafkajs import. The
 * client resolves CJS/ESM interop defensively because the published package
 * ships a CommonJS build whose Fluvio class is the DEFAULT export. The
 * Fluvio client exposes no disconnect() — close() flushes producers and
 * drops references (the native socket closes with the process).
 *
 * Scope honesty: the EventBus port is producer-only, so the port-level
 * telemetry covers publish spans + delivery/error counters. A `consume`
 * helper is provided on this class (not on the port) with a consumed-record
 * counter; a true consumer-LAG metric is not exposed by the @fluvio/client
 * JS surface (no high-watermark API), so none is fabricated.
 */
import {
  ProviderConfigError,
  ProviderRequestError
} from '../../modules/integrations/drivers/http.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import type { DomainEvent } from '../domain-events.service.js';
import {
  EVENT_BUS_CIRCUIT_COOLDOWN_MS,
  EVENT_BUS_CIRCUIT_THRESHOLD,
  EVENT_BUS_DEFAULT_TOPIC_PREFIX,
  type EventBus,
  type EventBusDriverStatus
} from './event-bus.driver.js';

/** Minimal producer surface so tests can inject fakes and the native client stays lazy. */
export interface FluvioProducerLike {
  send(key: string, value: string): Promise<unknown>;
  flush(): Promise<unknown>;
}

/** Minimal record surface consumed from a partition stream. */
export interface FluvioRecordLike {
  valueString(): string;
}

export interface FluvioPartitionConsumerLike {
  stream(offset: unknown, onRecord: (record: FluvioRecordLike) => void): Promise<void>;
}

export interface FluvioClientLike {
  topicProducer(topic: string): Promise<FluvioProducerLike>;
  partitionConsumer(topic: string, partition: number): Promise<FluvioPartitionConsumerLike>;
}

/** Creates a connected client for an endpoint (`host:port`). */
export type FluvioClientFactory = (endpoint: string) => Promise<FluvioClientLike>;

interface FluvioClass {
  connect(options: { host: string; port: number }): Promise<FluvioClientLike>;
}

interface FluvioModuleShape {
  Fluvio?: FluvioClass;
  Offset?: {
    new (options?: { index?: number; from?: string }): unknown;
    FromBeginning(): unknown;
  };
  default?: FluvioModuleShape | FluvioClass;
}

function parseEndpoint(endpoint: string): { host: string; port: number } {
  const trimmed = endpoint.replace(/^fluvio:\/\//i, '');
  const [host, portText] = trimmed.split(':');
  const port = portText ? Number(portText) : 9003;
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new ProviderConfigError('fluvio', ['FLUVIO_ENDPOINT (expected host:port)']);
  }
  return { host, port };
}

async function defaultClientFactory(endpoint: string): Promise<FluvioClientLike> {
  const mod = (await import('@fluvio/client')) as unknown as FluvioModuleShape;
  // CJS interop: the Fluvio class is the DEFAULT export of a CommonJS
  // build, so under Node ESM it surfaces at mod.default.default.
  const nested = mod.default as FluvioModuleShape | undefined;
  const Fluvio: FluvioClass | undefined =
    mod.Fluvio ??
    (typeof (mod.default as FluvioClass | undefined)?.connect === 'function'
      ? (mod.default as FluvioClass)
      : undefined) ??
    nested?.Fluvio;
  const Offset = mod.Offset ?? nested?.Offset;
  if (!Fluvio || typeof Fluvio.connect !== 'function') {
    throw new ProviderRequestError(
      'fluvio',
      'network',
      new Error('@fluvio/client default export did not resolve to the Fluvio class')
    );
  }
  const client = await Fluvio.connect(parseEndpoint(endpoint));
  return {
    topicProducer: (topic) => client.topicProducer(topic),
    partitionConsumer: async (topic, partition) => {
      const consumer = await client.partitionConsumer(topic, partition);
      return {
        // Translate the portable offset literal into the native Offset
        // class when the module exposes it.
        stream: (offset, onRecord) =>
          consumer.stream(
            Offset ? new Offset(offset as { index?: number; from?: string }) : offset,
            onRecord
          )
      };
    }
  };
}

function defaultOffsetFromBeginning(): unknown {
  return { index: 0, from: 'beginning' };
}

/**
 * Live Fluvio driver. The client connects lazily on first publish; topic
 * producers are cached per topic. Connection/send failures trip the same
 * call-time circuit breaker doctrine as the kafka driver and surface as
 * ProviderRequestError (mapped to 503 by callers) — fail closed.
 */
export class FluvioEventBus implements EventBus {
  readonly name = 'fluvio' as const;

  private client?: FluvioClientLike;
  private readonly producers = new Map<string, FluvioProducerLike>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly endpoint: string,
    private readonly options: {
      topicPrefix?: string;
      clientFactory?: FluvioClientFactory;
      telemetry?: TelemetryService;
    } = {}
  ) {
    this.telemetry = options.telemetry ?? new TelemetryService();
  }

  get topicPrefix(): string {
    const prefix = this.options.topicPrefix?.trim();
    return prefix && prefix.length > 0 ? prefix : EVENT_BUS_DEFAULT_TOPIC_PREFIX;
  }

  /**
   * Topic for an event name. Fluvio topic names allow only alphanumerics
   * and dashes, so the dot taxonomy is mapped to dashes.
   */
  topicFor(eventName: string): string {
    return `${this.topicPrefix}.${eventName}`.replace(/[^A-Za-z0-9-]/g, '-');
  }

  async publish(event: DomainEvent): Promise<void> {
    this.assertCircuitClosed();
    const topic = this.topicFor(event.name);
    const startedAt = Date.now();
    try {
      await this.telemetry.withSpan(
        'fluvio.publish',
        {
          'messaging.system': 'fluvio',
          'messaging.destination.name': topic,
          'messaging.operation': 'publish',
          'messaging.message.id': event.id
        },
        async () => {
          const producer = await this.ensureProducer(topic);
          await producer.send(event.id, JSON.stringify(event));
          await producer.flush();
        }
      );
      this.recordSuccess();
      this.telemetry.increment('eventbus.fluvio.deliveries.total', 1, {
        'messaging.system': 'fluvio',
        result: 'ok'
      });
      this.telemetry.record(
        'eventbus.fluvio.publish.duration_ms',
        Date.now() - startedAt,
        { 'messaging.system': 'fluvio', result: 'ok' }
      );
    } catch (error) {
      this.recordFailure();
      this.telemetry.increment('eventbus.fluvio.deliveries.total', 1, {
        'messaging.system': 'fluvio',
        result: 'error'
      });
      this.telemetry.record(
        'eventbus.fluvio.publish.duration_ms',
        Date.now() - startedAt,
        { 'messaging.system': 'fluvio', result: 'error' }
      );
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      throw new ProviderRequestError('fluvio', 'network', error);
    }
  }

  /**
   * Streams records from a topic partition (partition 0) and hands each
   * JSON payload to `onEvent`. Class-level helper — the EventBus port is
   * producer-only. Records a consumed counter per record; the JS client
   * exposes no high-watermark, so no consumer-lag gauge is fabricated.
   */
  async consume(topic: string, onEvent: (event: unknown) => void): Promise<void> {
    this.assertCircuitClosed();
    try {
      const client = await this.ensureClient();
      const consumer = await client.partitionConsumer(topic, 0);
      await consumer.stream(defaultOffsetFromBeginning(), (record) => {
        this.telemetry.increment('eventbus.fluvio.consumed.total', 1, {
          'messaging.system': 'fluvio',
          'messaging.destination.name': topic
        });
        try {
          onEvent(JSON.parse(record.valueString()));
        } catch {
          onEvent(record.valueString());
        }
      });
      this.recordSuccess();
    } catch (error) {
      this.recordFailure();
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      throw new ProviderRequestError('fluvio', 'network', error);
    }
  }

  status(): Promise<EventBusDriverStatus> {
    return Promise.resolve({
      configured: true,
      healthy: this.client !== undefined && !this.circuitOpen,
      detail: this.client
        ? this.circuitOpen
          ? `Fluvio client connected but circuit open after ${this.consecutiveFailures} consecutive failures.`
          : `Fluvio client connected to ${this.endpoint}.`
        : `Fluvio driver selected (endpoint ${this.endpoint}); client connects on first publish.`
    });
  }

  /**
   * The @fluvio/client surface has no disconnect(): close() drops producer
   * and client references so a subsequent publish reconnects; the native
   * socket is released with the process.
   */
  close(): Promise<void> {
    this.producers.clear();
    this.client = undefined;
    return Promise.resolve();
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= EVENT_BUS_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private async ensureClient(): Promise<FluvioClientLike> {
    if (!this.client) {
      const factory = this.options.clientFactory ?? defaultClientFactory;
      this.client = await factory(this.endpoint);
    }
    return this.client;
  }

  private async ensureProducer(topic: string): Promise<FluvioProducerLike> {
    let producer = this.producers.get(topic);
    if (!producer) {
      const client = await this.ensureClient();
      producer = await client.topicProducer(topic);
      this.producers.set(topic, producer);
    }
    return producer;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'fluvio',
        'network',
        new Error(
          `circuit open after ${this.consecutiveFailures} consecutive failures; retry after cooldown`
        )
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    this.producers.clear();
    this.client = undefined;
    if (this.consecutiveFailures >= EVENT_BUS_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + EVENT_BUS_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderRequestError };
