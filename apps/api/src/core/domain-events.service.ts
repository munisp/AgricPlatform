import { EventEmitter } from 'node:events';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '../common/async-repository.js';
import { OUTBOX_REPOSITORY } from '../database/persistence.tokens.js';
import type { OutboxRepository } from '../database/repositories/outbox.repository.js';

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
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository
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
    this.emit(event);
  }

  /** Listener fan-out only — for events already persisted transactionally. */
  emit<T>(event: DomainEvent<T>): void {
    this.logger.log(`event ${event.name} (${event.id})`);
    this.emitter.emit(event.name, event);
    this.emitter.emit('*', event);
  }

  on(name: string, handler: (event: DomainEvent) => void): void {
    this.emitter.on(name, handler);
  }

  /** Outbox snapshot, exposed read-only for admin/diagnostics. */
  async listOutbox(): Promise<DomainEvent[]> {
    return this.outbox.list();
  }
}
