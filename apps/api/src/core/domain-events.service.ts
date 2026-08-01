import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../common/in-memory.repository.js';

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
 * Domain event outbox. Phase 1 keeps an in-process outbox and emitter;
 * Phase 2 replaces the transport with a Kafka-compatible bus while keeping
 * the `{domain}.{entity}.{verb}` taxonomy from docs/architecture.md.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);
  private readonly emitter = new EventEmitter();
  private readonly outbox: DomainEvent[] = [];

  publish<T>(name: string, payload: T, actorId?: string): DomainEvent<T> {
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
    this.outbox.push(event as DomainEvent);
    this.logger.log(`event ${name} (${event.id})`);
    this.emitter.emit(name, event);
    this.emitter.emit('*', event);
    return event;
  }

  on(name: string, handler: (event: DomainEvent) => void): void {
    this.emitter.on(name, handler);
  }

  /** Outbox snapshot, exposed read-only for admin/diagnostics. */
  listOutbox(): DomainEvent[] {
    return [...this.outbox];
  }
}
