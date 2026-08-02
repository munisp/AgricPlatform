import { Inject, Injectable } from '@nestjs/common';
import { PROCESSED_EVENT_REPOSITORY } from '../database/persistence.tokens.js';
import type { ProcessedEventRepository } from '../database/repositories/processed-event.repository.js';

/**
 * Consumer-side idempotency (Wave P; events.processed_events). Listeners
 * call once() before handling a domain event; redeliveries from the outbox
 * sweeper are then ignored instead of double-handled.
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
}
