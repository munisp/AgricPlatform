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
}
