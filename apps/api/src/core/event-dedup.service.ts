import { Inject, Injectable } from '@nestjs/common';
import { PROCESSED_EVENT_REPOSITORY } from '../database/persistence.tokens.js';
import type { ProcessedEventRepository } from '../database/repositories/processed-event.repository.js';

/**
 * Consumer-side idempotency (Wave P; events.processed_events). Listeners
 * either call once() BEFORE handling (dedupe-first — only safe when the
 * handler has its own payload-level idempotency beneath), or has()/mark()
 * AROUND handling (mark-after-processing — a failed handling stays
 * unrecorded so the outbox sweeper re-drives it; the handler must tolerate
 * re-execution after a partial failure).
 */
@Injectable()
export class EventDedupService {
  /**
   * In-process serialization for the mark-after runOnce wrapper: has() and
   * mark() are a check-then-act pair, so two concurrent deliveries of the
   * same (consumer, eventId) would both pass has() before either marks. A
   * duplicate that arrives while the first delivery is in flight is skipped
   * — the in-flight handling completes the work, and if it fails the event
   * stays unrecorded so the outbox sweeper re-drives it.
   */
  private readonly inflight = new Set<string>();

  constructor(
    @Inject(PROCESSED_EVENT_REPOSITORY) private readonly processed: ProcessedEventRepository
  ) {}

  /** True on first delivery for this consumer; false on duplicates. */
  async once(consumer: string, eventId: string): Promise<boolean> {
    return this.processed.tryRecord(consumer, eventId);
  }

  /** True when (consumer, eventId) is already recorded as processed. */
  async has(consumer: string, eventId: string): Promise<boolean> {
    return this.processed.has(consumer, eventId);
  }

  /** Records (consumer, eventId) AFTER successful handling. */
  async mark(consumer: string, eventId: string): Promise<void> {
    await this.processed.tryRecord(consumer, eventId);
  }

  /**
   * Dedup-guarded listener execution (GAP-M09): the generalised
   * mark-AFTER-processing doctrine of RecallNotificationsListener. The
   * handler runs only when (consumer, eventId) has no processed record and
   * no in-flight delivery; the record is written ONLY after the handler
   * resolves, so a failed handling stays unrecorded and the outbox sweeper
   * re-drives the event (re-drive converges instead of duplicating — the
   * handler must tolerate re-execution after a partial failure). Returns
   * true when the handler ran, false when the delivery was skipped as a
   * duplicate (already processed or currently in flight).
   */
  async runOnce(consumer: string, eventId: string, handler: () => unknown): Promise<boolean> {
    const key = `${consumer} ${eventId}`;
    // The has-and-add MUST stay synchronous (before the first await) so a
    // same-tick duplicate emitted while this delivery is in flight is
    // skipped rather than double-processed.
    if (this.inflight.has(key)) {
      return false;
    }
    this.inflight.add(key);
    try {
      if (await this.has(consumer, eventId)) {
        return false;
      }
      await handler();
      await this.mark(consumer, eventId);
      return true;
    } finally {
      this.inflight.delete(key);
    }
  }
}
