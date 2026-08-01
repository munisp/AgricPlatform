import type { DomainEvent } from '../../core/domain-events.service.js';

/** Append-only domain event outbox (events.outbox). */
export interface OutboxRepository {
  append(event: DomainEvent): Promise<DomainEvent>;
  list(): Promise<DomainEvent[]>;
}

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly events: DomainEvent[] = [];

  async append(event: DomainEvent): Promise<DomainEvent> {
    this.events.push(event);
    return event;
  }

  async list(): Promise<DomainEvent[]> {
    return [...this.events];
  }
}

export function createInMemoryOutboxRepository(): InMemoryOutboxRepository {
  return new InMemoryOutboxRepository();
}
