import { EventEmitter } from 'node:events';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { newId } from '../common/async-repository.js';
import { OUTBOX_REPOSITORY } from '../database/persistence.tokens.js';
import type { OutboxRepository } from '../database/repositories/outbox.repository.js';
import { EVENT_BUS, type EventBus } from './events/event-bus.driver.js';

export interface DomainEvent<T = unknown> {
  id: string;
  /** Event name using the `{domain}.{entity}.{verb}` taxonomy. */
  name: string;
  payload: T;
  actorId?: string;
  occurredAt: string;
}

const EVENT_NAME_PATTERN = /^[a-z_]+\.[a-z_]+\.[a-z_]+$/;

/**
 * Domain event outbox. The outbox persists through the injected
 * OutboxRepository (in-memory by default, events.outbox in PostgreSQL);
 * the EventEmitter fan-out stays synchronous after the event is persisted.
 * Phase 2 replaces the transport with a Kafka-compatible bus while keeping
 * the `{domain}.{entity}.{verb}` taxonomy from docs/architecture.md.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);
  private readonly emitter = new EventEmitter();

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Optional() @Inject(EVENT_BUS) private readonly bus?: EventBus
  ) {}

  async publish<T>(name: string, payload: T, actorId?: string): Promise<DomainEvent<T>> {
    const event = this.build(name, payload, actorId);
    await this.persist(event);
    return event;
  }

  /**
   * Validates and constructs the event WITHOUT persisting or emitting it.
   * Funds-affecting flows hand the built event to a repository that appends
   * it to events.outbox inside the same database transaction as the state
   * change (AsyncRepository.updateExpected), then call emit() after commit.
   */
  build<T>(name: string, payload: T, actorId?: string): DomainEvent<T> {
    if (!EVENT_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid domain event name '${name}'. Expected '{domain}.{entity}.{verb}' taxonomy.`
      );
    }
    return {
      id: newId('event'),
      name,
      payload,
      actorId,
      occurredAt: new Date().toISOString()
    };
  }

  /** Appends a pre-built event to the outbox, then fans out to listeners. */
  async persist<T>(event: DomainEvent<T>): Promise<void> {
    await this.outbox.append(event as DomainEvent);
    // Wave FABRIC: with a live event-bus driver selected (EVENT_BUS_DRIVER),
    // the event is published to the external bus BEFORE listener fan-out and
    // bus failures fail closed (publish throws — callers answer 503). The
    // default stub bus is a no-op, so default behaviour is unchanged.
    if (this.bus && this.bus.name !== 'stub') {
      await this.bus.publish(event as DomainEvent);
    }
    this.fanOut(event);
    // Deterministic publish marking on the non-transactional path (the
    // transactional path's post-commit emit marks fire-and-forget).
    await this.markPublished(event.id);
  }

  /** Listener fan-out only — for events already persisted transactionally. */
  emit<T>(event: DomainEvent<T>): void {
    // Wave FABRIC (transactional path): state is already committed, so bus
    // delivery here is best-effort — failures are logged, not thrown, and
    // the outbox row remains for the sweeper to retry.
    if (this.bus && this.bus.name !== 'stub') {
      void this.bus.publish(event as DomainEvent).catch((error: unknown) => {
        this.logger.warn(
          `event-bus publish failed for ${event.name} (${event.id}): ${(error as Error)?.message ?? error}`
        );
      });
    }
    this.fanOut(event);
    // Wave P: mark the outbox row published after successful fan-out so the
    // sweeper only retries rows whose delivery actually stalled.
    void this.markPublished(event.id);
  }

  private fanOut<T>(event: DomainEvent<T>): void {
    this.logger.log(`event ${event.name} (${event.id})`);
    this.emitter.emit(event.name, event);
    this.emitter.emit('*', event);
  }

  /**
   * Best-effort published marking: repositories predating the sweeper (and
   * test doubles) may lack the method; failures never break fan-out.
   */
  private async markPublished(eventId: string): Promise<void> {
    try {
      await this.outbox.markPublished?.(eventId, new Date().toISOString());
    } catch {
      // Non-fatal: the sweeper will retry the row later.
    }
  }

  on(name: string, handler: (event: DomainEvent) => void): void {
    this.emitter.on(name, handler);
  }

  /** Outbox snapshot, exposed read-only for admin/diagnostics. */
  async listOutbox(): Promise<DomainEvent[]> {
    return this.outbox.list();
  }
}
