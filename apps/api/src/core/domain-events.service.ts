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
    if (!EVENT_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid domain event name '${name}'. Expected '{domain}.{entity}.{verb}' taxonomy.`
      );
    }
    const event: DomainEvent<T> = {
      id: newId('event'),
      name,
      payload,
      actorId,
      occurredAt: new Date().toISOString()
    };
    await this.outbox.append(event as DomainEvent);
    this.logger.log(`event ${name} (${event.id})`);
    this.emitter.emit(name, event);
    this.emitter.emit('*', event);
    return event;
  }

  on(name: string, handler: (event: DomainEvent) => void): void {
    this.emitter.on(name, handler);
  }

  /** Outbox snapshot, exposed read-only for admin/diagnostics. */
  async listOutbox(): Promise<DomainEvent[]> {
    return this.outbox.list();
  }
}
