import type { DomainEvent } from '../../core/domain-events.service.js';

/**
 * Transactional outbox store (events.outbox, migration 012). Writers append
 * the event in the SAME transaction as the entity write; the relay marks it
 * published after fan-out; the sweeper retries with backoff.
 */
export interface OutboxRecord {
  event: DomainEvent;
  publishedAt?: string;
  attempts: number;
  deadLetteredAt?: string;
}

/**
 * GAP-L03: default page size for outbox LIST reads. Unbounded selects over
 * the outbox table let a deep backlog OOM the API process (and the
 * dead-letter/ops reads grow without bound). Oldest-first ordering is kept
 * so the relay semantics are unchanged; the sweeper drains page by page
 * (OUTBOX_SWEEP_MAX_PAGES) instead of assuming one read covers everything.
 */
export const OUTBOX_LIST_DEFAULT_LIMIT = 1000;

export interface OutboxRepository {
  append(event: DomainEvent): Promise<void>;
  list(): Promise<DomainEvent[]>;
  /**
   * All known rows (any state), oldest first. Callers that only need
   * pending rows should prefer listPendingRecords — this read includes
   * published/dead-lettered history for ops surfaces and is bounded by
   * OUTBOX_LIST_DEFAULT_LIMIT (GAP-L03).
   */
  listRecords(): Promise<OutboxRecord[]>;
  /**
   * Pending rows only (unpublished, not dead-lettered), oldest first,
   * LIMIT `limit` OFFSET `skip` (GAP-L03). The sweeper pages through the
   * backlog with this instead of materialising the whole table.
   */
  listPendingRecords(limit?: number, skip?: number): Promise<OutboxRecord[]>;
  markPublished(id: string, at: string): Promise<void>;
  /** Increments the relay attempt counter; returns the new count. */
  recordAttempt(id: string): Promise<number>;
  markDeadLetter(id: string, at: string): Promise<void>;
  /** V-79: clears dead_lettered_at + attempts so the row relays again. */
  resetDeadLetter(id: string): Promise<void>;
}

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly records: OutboxRecord[] = [];

  async append(event: DomainEvent): Promise<void> {
    this.records.push({ event, attempts: 0 });
  }

  async list(): Promise<DomainEvent[]> {
    return this.records.map((record) => record.event);
  }

  async listRecords(): Promise<OutboxRecord[]> {
    // GAP-L03: same bound as the pg driver.
    return this.records
      .map((record) => ({ ...record }))
      .slice(0, OUTBOX_LIST_DEFAULT_LIMIT);
  }

  async listPendingRecords(
    limit: number = OUTBOX_LIST_DEFAULT_LIMIT,
    skip = 0
  ): Promise<OutboxRecord[]> {
    return this.records
      .filter((record) => !record.publishedAt && !record.deadLetteredAt)
      .slice(skip, skip + Math.max(0, limit))
      .map((record) => ({ ...record }));
  }

  async markPublished(id: string, at: string): Promise<void> {
    const record = this.records.find((row) => row.event.id === id);
    if (record) {
      record.publishedAt = at;
    }
  }

  async recordAttempt(id: string): Promise<number> {
    const record = this.records.find((row) => row.event.id === id);
    if (!record) {
      return 0;
    }
    record.attempts += 1;
    return record.attempts;
  }

  async markDeadLetter(id: string, at: string): Promise<void> {
    const record = this.records.find((row) => row.event.id === id);
    if (record) {
      record.deadLetteredAt = at;
    }
  }

  async resetDeadLetter(id: string): Promise<void> {
    const record = this.records.find((row) => row.event.id === id);
    if (record) {
      record.deadLetteredAt = undefined;
      record.attempts = 0;
    }
  }
}

export function createInMemoryOutboxRepository(): InMemoryOutboxRepository {
  return new InMemoryOutboxRepository();
}
