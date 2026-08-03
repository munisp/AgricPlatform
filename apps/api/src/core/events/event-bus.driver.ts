/**
 * Event-bus drivers (wave FABRIC): the domain-event transport behind one
 * EventBus port. The stub driver is the DEFAULT and is a deliberate no-op —
 * the current in-process behaviour (outbox append + synchronous EventEmitter
 * fan-out inside DomainEventsService) stays exactly as it is. Setting
 * EVENT_BUS_DRIVER=kafka selects the Kafka driver, which REQUIRES
 * KAFKA_BROKERS and fails closed: the factory throws ProviderConfigError at
 * boot when the brokers are absent, and publish failures raise
 * ProviderRequestError (mapped to 503 by callers) — never a silent fallback
 * to the stub. Mirrors the geo-intel flood-risk driver convention,
 * including the call-time circuit breaker.
 */
import {
  ProviderConfigError,
  ProviderRequestError,
  requireEnv
} from '../../modules/integrations/drivers/http.js';
import type { DomainEvent } from '../domain-events.service.js';

/** DI token for the selected EventBus driver. */
export const EVENT_BUS = Symbol('EVENT_BUS');

/** Number of consecutive publish failures before the circuit opens. */
export const EVENT_BUS_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next publish is allowed through. */
export const EVENT_BUS_CIRCUIT_COOLDOWN_MS = 30_000;
/** Default Kafka topic prefix; the full topic is `${prefix}.${event.name}`. */
export const EVENT_BUS_DEFAULT_TOPIC_PREFIX = 'agric.domain';

export interface EventBusDriverStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface EventBus {
  readonly name: 'stub' | 'kafka';
  /** Publishes an already-persisted domain event to the external bus. */
  publish(event: DomainEvent): Promise<void>;
  status(): Promise<EventBusDriverStatus>;
  /** Releases broker connections (no-op for the stub). */
  close(): Promise<void>;
}

/**
 * Minimal producer surface (a kafkajs Producer subset) so tests can inject
 * fakes and the kafkajs import stays lazy — the client library is only
 * loaded when the kafka driver is actually selected.
 */
export interface KafkaProducerLike {
  connect(): Promise<void>;
  send(record: {
    topic: string;
    messages: Array<{ key?: string; value: string }>;
  }): Promise<unknown>;
  disconnect(): Promise<void>;
}

export type KafkaProducerFactory = () => Promise<KafkaProducerLike>;

async function defaultProducerFactory(brokers: string[]): Promise<KafkaProducerLike> {
  const { Kafka, logLevel } = await import('kafkajs');
  const kafka = new Kafka({
    clientId: 'agric-platform-api',
    brokers,
    logLevel: logLevel.NOTHING
  });
  return kafka.producer();
}

/**
 * Default driver: a labelled no-op. The outbox + in-process EventEmitter in
 * DomainEventsService remain the transport, exactly as before this port
 * existed. Selected implicitly whenever EVENT_BUS_DRIVER is unset.
 */
export class StubEventBus implements EventBus {
  readonly name = 'stub' as const;

  publish(event: DomainEvent): Promise<void> {
    void event; // no-op: the in-process outbox + EventEmitter is the transport
    return Promise.resolve();
  }

  status(): Promise<EventBusDriverStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: in-process outbox + EventEmitter transport (no external bus). ' +
        'Set EVENT_BUS_DRIVER=kafka and KAFKA_BROKERS to publish domain events to Kafka.'
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Live Kafka driver (kafkajs). The producer connects lazily on first
 * publish; connection and send failures trip a call-time circuit breaker
 * (no in-process timers) after EVENT_BUS_CIRCUIT_THRESHOLD consecutive
 * failures, and every failure surfaces as ProviderRequestError so callers
 * answer 503 instead of degrading silently.
 */
export class KafkaEventBus implements EventBus {
  readonly name = 'kafka' as const;

  private producer?: KafkaProducerLike;
  private connected = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly brokers: string[],
    private readonly options: {
      topicPrefix?: string;
      producerFactory?: KafkaProducerFactory;
    } = {}
  ) {}

  get topicPrefix(): string {
    const prefix = this.options.topicPrefix?.trim();
    return prefix && prefix.length > 0 ? prefix : EVENT_BUS_DEFAULT_TOPIC_PREFIX;
  }

  /** Topic for an event name (`{domain}.{entity}.{verb}` taxonomy). */
  topicFor(eventName: string): string {
    return `${this.topicPrefix}.${eventName}`;
  }

  async publish(event: DomainEvent): Promise<void> {
    this.assertCircuitClosed();
    try {
      const producer = await this.ensureProducer();
      await producer.send({
        topic: this.topicFor(event.name),
        messages: [{ key: event.id, value: JSON.stringify(event) }]
      });
      this.recordSuccess();
    } catch (error) {
      this.recordFailure();
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      throw new ProviderRequestError('kafka', 'network', error);
    }
  }

  status(): Promise<EventBusDriverStatus> {
    return Promise.resolve({
      configured: true,
      healthy: this.connected && !this.circuitOpen,
      detail: this.connected
        ? this.circuitOpen
          ? `Kafka producer connected but circuit open after ${this.consecutiveFailures} consecutive failures.`
          : `Kafka producer connected to ${this.brokers.join(', ')}.`
        : `Kafka driver selected (brokers ${this.brokers.join(', ')}); producer connects on first publish.`
    });
  }

  async close(): Promise<void> {
    if (this.producer && this.connected) {
      await this.producer.disconnect();
    }
    this.connected = false;
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= EVENT_BUS_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private async ensureProducer(): Promise<KafkaProducerLike> {
    if (!this.producer) {
      const factory =
        this.options.producerFactory ?? (() => defaultProducerFactory(this.brokers));
      this.producer = await factory();
    }
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    return this.producer;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'kafka',
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
    this.connected = false;
    if (this.consecutiveFailures >= EVENT_BUS_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + EVENT_BUS_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderRequestError };

/**
 * Builds the configured driver. Default is the stub (current in-process
 * behaviour); EVENT_BUS_DRIVER=kafka requires KAFKA_BROKERS
 * (comma-separated host:port list) and fails closed with
 * ProviderConfigError otherwise — so boot aborts instead of silently
 * running without a bus.
 */
export function createEventBus(env: NodeJS.ProcessEnv = process.env): EventBus {
  const flag = (env.EVENT_BUS_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'kafka') {
    const brokers = requireEnv('kafka', env, ['KAFKA_BROKERS'])
      .split(',')
      .map((broker) => broker.trim())
      .filter((broker) => broker.length > 0);
    if (brokers.length === 0) {
      throw new ProviderConfigError('kafka', ['KAFKA_BROKERS']);
    }
    return new KafkaEventBus(brokers, { topicPrefix: env.KAFKA_TOPIC_PREFIX });
  }
  return new StubEventBus();
}
