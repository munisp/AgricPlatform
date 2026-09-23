import type { DomainEvent } from '../../core/domain-events.service.js';

/** Outbox row with relay state (Wave P sweeper). */
export interface OutboxRecord {
  event: DomainEvent;
  publishedAt?: string;
  attempts: number;
  deadLetteredAt?: string;
}

/**
 * Default bound for outbox list reads (P2 perf): the outbox is append-only
 * and grows until the compliance retention sweep, so an unbounded
 * SELECT … ORDER BY occurred_at fully materializes the table. List reads
 * are capped at this many oldest rows unless the caller passes an explicit
 * limit; callers draining a deeper backlog rely on repeated sweeps — each
 * pass publishes or dead-letters the oldest rows, shrinking the queue head.
 */
export const OUTBOX_LIST_DEFAULT_LIMIT = 1000;
/** Hard ceiling for an explicit outbox list limit. */
export const OUTBOX_LIST_MAX_LIMIT = 10_000;

/** Clamps an optional outbox list limit to [1, OUTBOX_LIST_MAX_LIMIT]. */
export function boundOutboxListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return OUTBOX_LIST_DEFAULT_LIMIT;
  }
  return Math.min(OUTBOX_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Domain event outbox (events.outbox). append/list preserve the original
 * contract; the record-level methods power the Wave P sweeper (retry
 * stalled rows with backoff, dead-letter after max attempts).
 */
export interface OutboxRepository {
  append(event: DomainEvent): Promise<DomainEvent>;
  /**
   * Oldest events first (occurred_at order), bounded by `limit`
   * (default OUTBOX_LIST_DEFAULT_LIMIT).
   */
  list(limit?: number): Promise<DomainEvent[]>;
  /**
   * Oldest rows (occurred_at order) with relay state, bounded by `limit`
   * (default OUTBOX_LIST_DEFAULT_LIMIT). Callers needing the full backlog
   * must page via repeated sweeps.
   */
  listRecords(limit?: number): Promise<OutboxRecord[]>;
  markPublished(id: string, publishedAt: string): Promise<void>;
  /** Increments the attempt counter; returns the new count. */
  recordAttempt(id: string): Promise<number>;
  markDeadLetter(id: string, deadLetteredAt: string): Promise<void>;
  /**
   * V-79 redrive: clears dead_lettered_at and attempts so the next sweep
   * re-delivers the row. Returns false when no dead-lettered row with that
   * id exists (nothing to resurrect).
   */
  resetDeadLetter(id: string): Promise<boolean>;
  /** Retention sweeper (V-27): published rows whose published_at < cutoff. */
  countPublishedBefore(cutoff: string): Promise<number>;
  /**
   * Retention sweeper (V-27): scrubs the payload on published rows older
   * than the cutoff, keeping the event metadata as relay history. The
   * column is jsonb NOT NULL, so the tombstone is an empty object — never
   * NULL. Rows already tombstoned are skipped (idempotent). Returns rows
   * changed.
   */
  anonymizePublishedBefore(cutoff: string): Promise<number>;
  /** Retention sweeper (V-27): hard-deletes published rows older than the cutoff. */
  purgePublishedBefore(cutoff: string): Promise<number>;
}

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly events: DomainEvent[] = [];
  private readonly state = new Map<string, { publishedAt?: string; attempts: number; deadLetteredAt?: string }>();

  async append(event: DomainEvent): Promise<DomainEvent> {
    this.events.push(event);
    this.state.set(event.id, { attempts: 0 });
    return event;
  }

  async list(limit?: number): Promise<DomainEvent[]> {
    return this.events.slice(0, boundOutboxListLimit(limit));
  }

  async listRecords(limit?: number): Promise<OutboxRecord[]> {
    return this.events.slice(0, boundOutboxListLimit(limit)).map((event) => {
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

  async resetDeadLetter(id: string): Promise<boolean> {
    const state = this.state.get(id);
    if (!state || !state.deadLetteredAt) {
      return false;
    }
    delete state.deadLetteredAt;
    state.attempts = 0;
    return true;
  }

  async countPublishedBefore(cutoff: string): Promise<number> {
    return this.events.filter((event) => {
      const publishedAt = this.state.get(event.id)?.publishedAt;
      return publishedAt !== undefined && publishedAt < cutoff;
    }).length;
  }

  async anonymizePublishedBefore(cutoff: string): Promise<number> {
    let changed = 0;
    for (const event of this.events) {
      const publishedAt = this.state.get(event.id)?.publishedAt;
      if (publishedAt === undefined || publishedAt >= cutoff) continue;
      const payload = event.payload;
      if (
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        Object.keys(payload as Record<string, unknown>).length === 0
      ) {
        continue; // already tombstoned
      }
      event.payload = {};
      changed += 1;
    }
    return changed;
  }

  async purgePublishedBefore(cutoff: string): Promise<number> {
    const expired = this.events.filter((event) => {
      const publishedAt = this.state.get(event.id)?.publishedAt;
      return publishedAt !== undefined && publishedAt < cutoff;
    });
    for (const event of expired) {
      this.events.splice(this.events.indexOf(event), 1);
      this.state.delete(event.id);
    }
    return expired.length;
  }
}

export function createInMemoryOutboxRepository(): InMemoryOutboxRepository {
  return new InMemoryOutboxRepository();
}
