import { Inject, Injectable, Logger } from '@nestjs/common';
import { OUTBOX_REPOSITORY } from '../database/persistence.tokens.js';
import type { OutboxRecord, OutboxRepository } from '../database/repositories/outbox.repository.js';
import { DomainEventsService } from './domain-events.service.js';

/** Max relay attempts before an outbox row is dead-lettered. */
export const OUTBOX_MAX_ATTEMPTS = 8;
/** Base backoff between relay attempts (doubles per attempt). */
export const OUTBOX_RETRY_BASE_MS = 30_000;

export interface OutboxSweepResult {
  published: number;
  failed: number;
  deadLettered: number;
  /** Rows still inside their backoff window. */
  deferred: number;
}

/**
 * Outbox sweeper (Wave P). The in-process relay marks rows published when
 * listeners are fanned out; rows that threw during fan-out are retried with
 * exponential backoff and dead-lettered after OUTBOX_MAX_ATTEMPTS. Invoked
 * via POST /admin/outbox/sweep — an external scheduler should call that
 * endpoint; the API starts no timers of its own.
 */
@Injectable()
export class OutboxSweeperService {
  private readonly logger = new Logger(OutboxSweeperService.name);

  constructor(
    private readonly events: DomainEventsService,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository
  ) {}

  backoffMs(attempts: number): number {
    return OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  }

  /** Unpublished, non-dead-lettered rows whose backoff window has elapsed. */
  async due(now: Date = new Date()): Promise<OutboxRecord[]> {
    return (await this.outbox.listRecords()).filter((record) => {
      if (record.publishedAt || record.deadLetteredAt) {
        return false;
      }
      if (record.attempts === 0) {
        return true;
      }
      const earliest =
        new Date(record.event.occurredAt).getTime() + this.backoffMs(record.attempts);
      return now.getTime() >= earliest;
    });
  }

  /** Pending backlog (unpublished, not dead-lettered) — health probe input. */
  async backlog(): Promise<{ pending: number; deadLettered: number }> {
    const records = await this.outbox.listRecords();
    return {
      pending: records.filter((record) => !record.publishedAt && !record.deadLetteredAt).length,
      deadLettered: records.filter((record) => record.deadLetteredAt).length
    };
  }

  async deadLetters(): Promise<OutboxRecord[]> {
    return (await this.outbox.listRecords()).filter((record) => record.deadLetteredAt);
  }

  /**
   * One sweep pass: re-emits due rows through the AWAITABLE bus path and
   * marks them published only after the bus accepts the event; bus/listener
   * failures increment attempts and eventually dead-letter the row.
   * Consumer-side dedup (events.processed_events) makes re-delivery safe.
   */
  async sweep(now: Date = new Date()): Promise<OutboxSweepResult> {
    const result: OutboxSweepResult = { published: 0, failed: 0, deadLettered: 0, deferred: 0 };
    const records = await this.outbox.listRecords();
    for (const record of records) {
      if (record.publishedAt || record.deadLetteredAt) {
        continue;
      }
      if (record.attempts > 0) {
        const earliest =
          new Date(record.event.occurredAt).getTime() + this.backoffMs(record.attempts);
        if (now.getTime() < earliest) {
          result.deferred += 1;
          continue;
        }
      }
      try {
        // Audit C2: await bus acceptance BEFORE marking published. The old
        // fire-and-forget emit() marked the row published unconditionally,
        // permanently losing events the broker had rejected.
        await this.events.emitAwaitable(record.event);
        await this.outbox.markPublished(record.event.id, now.toISOString());
        result.published += 1;
      } catch (error) {
        const attempts = await this.outbox.recordAttempt(record.event.id);
        result.failed += 1;
        this.logger.warn(
          `outbox relay failed for ${record.event.id} (attempt ${attempts}): ${(error as Error).message}`
        );
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          await this.outbox.markDeadLetter(record.event.id, now.toISOString());
          result.deadLettered += 1;
        }
      }
    }
    return result;
  }
}
