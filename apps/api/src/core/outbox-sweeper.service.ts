import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OUTBOX_REPOSITORY } from '../database/persistence.tokens.js';
import type { OutboxRecord, OutboxRepository } from '../database/repositories/outbox.repository.js';
import { DomainEventsService } from './domain-events.service.js';

/** Max relay attempts before an outbox row is dead-lettered. */
export const OUTBOX_MAX_ATTEMPTS = 8;
/** Base backoff between relay attempts (doubles per attempt). */
export const OUTBOX_RETRY_BASE_MS = 30_000;
/**
 * GAP-L03: max outbox pages drained per sweep pass. Repository list reads
 * are bounded (OUTBOX_LIST_DEFAULT_LIMIT rows, oldest first), so one pass
 * used to touch only the first page and deep backlogs drained over many
 * invocations. The sweep now loops pages until a page makes no state
 * change (everything left is deferred or terminal) or this cap is hit —
 * the cap keeps one pass bounded when the backlog grows faster than the
 * relay drains it.
 */
export const OUTBOX_SWEEP_MAX_PAGES = 10;

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
 * exponential backoff and dead-lettered after OUTBOX_MAX_ATTEMPTS. Driven
 * two ways (GAP-M03): the in-process OutboxRelaySchedulerService timer
 * (default ON outside production) and POST /admin/outbox/sweep, invoked by
 * the outbox-relayer CronJob that ships in the default kustomization.
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
   * V-79 redrive: resurrect a dead-lettered row — clears dead_lettered_at
   * and the attempt counter so the next sweep re-delivers it (consumer-side
   * dedup via events.processed_events makes re-delivery safe). 404 when no
   * dead-lettered row with that id exists.
   */
  async redriveDeadLetter(id: string): Promise<OutboxRecord> {
    const record = (await this.outbox.listRecords()).find((row) => row.event.id === id);
    if (!record || !record.deadLetteredAt) {
      throw new NotFoundException(`No dead-lettered outbox row '${id}'`);
    }
    await this.outbox.resetDeadLetter(id);
    return record;
  }

  /**
   * One sweep pass: re-emits due rows through the AWAITABLE bus path and
   * marks them published only after the bus accepts the event; bus/listener
   * failures increment attempts and eventually dead-letter the row.
   * Consumer-side dedup (events.processed_events) makes re-delivery safe.
   */
  async sweep(now: Date = new Date()): Promise<OutboxSweepResult> {
    const result: OutboxSweepResult = { published: 0, failed: 0, deadLettered: 0, deferred: 0 };
    // GAP-L03: paged drain. `processed` stops a row whose state already
    // changed this sweep from being re-driven by a later page (its backoff
    // window may already have elapsed, so a naive loop would retry a
    // failing row OUTBOX_SWEEP_MAX_PAGES times in one pass); `deferred`
    // dedupes the deferred count across pages.
    const deferred = new Set<string>();
    let skip = 0;
    for (let page = 0; page < OUTBOX_SWEEP_MAX_PAGES; page += 1) {
      const records = await this.outbox.listPendingRecords(undefined, skip);
      if (records.length === 0) {
        break;
      }
      skip = await this.sweepPage(now, records, skip, deferred, result);
    }
    result.deferred = deferred.size;
    return result;
  }

  /**
   * One page of a sweep (GAP-L03): drives each due pending row (publishing it
   * or recording an attempt) and counts the still-deferred ones. Returns the
   * advanced `skip` offset past rows that remain pending (failed → backoff, or
   * still deferred), so a failing row is driven once per pass instead of
   * OUTBOX_SWEEP_MAX_PAGES times; rows it publishes/dead-letters drop out of
   * the pending set, so the unread front always advances to fresh rows.
   */
  private async sweepPage(
    now: Date,
    records: OutboxRecord[],
    skip: number,
    deferred: Set<string>,
    result: OutboxSweepResult
  ): Promise<number> {
    for (const record of records) {
      if (record.attempts > 0) {
        const earliest =
          new Date(record.event.occurredAt).getTime() + this.backoffMs(record.attempts);
        if (now.getTime() < earliest) {
          deferred.add(record.event.id);
          skip += 1;
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
        } else {
          // Failed row stays pending (now inside its backoff window): skip it on
          // the next page so it is driven once per pass, not MAX_PAGES times.
          skip += 1;
        }
      }
    }
    return skip;
  }
}
