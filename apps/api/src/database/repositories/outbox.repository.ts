import type { DomainEvent } from '../../core/domain-events.service.js';

/** Outbox row with relay state (Wave P sweeper). */
export interface OutboxRecord {
  event: DomainEvent;
  publishedAt?: string;
  attempts: number;
  deadLetteredAt?: string;
}

/**
 * Domain event outbox (events.outbox). append/list preserve the original
 * contract; the record-level methods power the Wave P sweeper (retry
 * stalled rows with backoff, dead-letter after max attempts).
 */
export interface OutboxRepository {
  append(event: DomainEvent): Promise<DomainEvent>;
  list(): Promise<DomainEvent[]>;
  /** All rows with relay state, ordered by occurred_at. */
  listRecords(): Promise<OutboxRecord[]>;
  markPublished(id: string, publishedAt: string): Promise<void>;
  /** Increments the attempt counter; returns the new count. */
  recordAttempt(id: string): Promise<number>;
  markDeadLetter(id: string, deadLetteredAt: string): Promise<void>;
}

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly events: DomainEvent[] = [];
  private readonly state = new Map<string, { publishedAt?: string; attempts: number; deadLetteredAt?: string }>();

  async append(event: DomainEvent): Promise<DomainEvent> {
    this.events.push(event);
    this.state.set(event.id, { attempts: 0 });
    return event;
  }

  async list(): Promise<DomainEvent[]> {
    return [...this.events];
  }

  async listRecords(): Promise<OutboxRecord[]> {
    return this.events.map((event) => {
      const state = this.state.get(event.id) ?? { attempts: 0 };
      return {
        event,
        attempts: state.attempts,
        ...(state.publishedAt ? { publishedAt: state.publishedAt } : {}),
        ...(state.deadLetteredAt ? { deadLetteredAt: state.deadLetteredAt } : {})
      };
    });
  }

  async markPublished(id: string, publishedAt: string): Promise<void> {
    const state = this.state.get(id);
    if (state) {
      state.publishedAt = publishedAt;
    }
  }

  async recordAttempt(id: string): Promise<number> {
    const state = this.state.get(id);
    if (!state) {
      return 0;
    }
    state.attempts += 1;
    return state.attempts;
  }

  async markDeadLetter(id: string, deadLetteredAt: string): Promise<void> {
    const state = this.state.get(id);
    if (state) {
      state.deadLetteredAt = deadLetteredAt;
    }
  }
}

export function createInMemoryOutboxRepository(): InMemoryOutboxRepository {
  return new InMemoryOutboxRepository();
}
