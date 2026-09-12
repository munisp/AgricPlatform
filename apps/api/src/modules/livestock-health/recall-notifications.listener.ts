import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LivestockHealthService } from './livestock-health.service.js';

/**
 * Recall fan-out (wave L1b, blueprint F4.2 — 24-hour traceback). Listens for
 * `livestock.recall.initiated`, notifies every affected owner in-app, then
 * flips the case initiated → notified so it can be resolved. Delivery
 * failures are logged and never block the lifecycle flip — the recall case
 * itself is the auditable record, and undelivered messages stay visible in
 * the notification log.
 *
 * Consumer idempotency (G14): mark-AFTER-processing, the analytics
 * projector pattern (has() before handling, mark() only after the lifecycle
 * flip succeeds). The previous mark-before once() recorded the event up
 * front, so a post-once failure (e.g. the lifecycle flip throwing) was
 * permanently suppressed from outbox-sweeper redrives and the recall stayed
 * stuck in 'initiated' — unresolvable. With mark-after, a failure leaves
 * the event unrecorded and the next redrive retries it; the flip itself is
 * idempotent (LivestockHealthService.markRecallNotified returns an
 * already-'notified' recall unchanged), so a crash between flip and mark
 * converges on redrive instead of failing forever. The mark-before
 * whatsapp-inbound pattern does NOT fit here: it is safe only because a
 * provider-message-id setNx dedups beneath it, and this fan-out has no
 * equivalent payload-level dedup.
 */
@Injectable()
export class RecallNotificationsListener implements OnModuleInit {
  private readonly logger = new Logger(RecallNotificationsListener.name);
  /**
   * In-process serialization for mark-after dedup: has()/mark() is a
   * check-then-act pair, so two concurrent deliveries of the same event id
   * would both pass has() before either marks (the analytics projector
   * avoids this by processing sequentially in one run loop). A duplicate
   * that arrives while the first delivery is still in flight is skipped —
   * the in-flight handling completes the work, and if it fails the event
   * stays unmarked for the sweeper to redrive.
   */
  private readonly inflight = new Set<string>();

  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly health: LivestockHealthService,
    // @Optional: unit specs construct the listener directly; Nest injects the
    // shared EventDedupService (events.processed_events) at runtime so
    // outbox-sweeper redeliveries of livestock.recall.initiated do not
    // re-notify owners (G17, same wiring as webhook-dispatch).
    @Optional()
    private readonly dedup: EventDedupService = new EventDedupService(
      createInMemoryProcessedEventRepository()
    )
  ) {}

  onModuleInit(): void {
    this.events.on('livestock.recall.initiated', (event: DomainEvent) => {
      void this.handleRecallInitiated(event).catch((error) =>
        this.logger.warn(`recall notification fan-out failed: ${(error as Error).message}`)
      );
    });
  }

  private async handleRecallInitiated(event: DomainEvent): Promise<void> {
    // Consumer-side dedup (mark-after, G14): skip events already recorded as
    // processed; record ONLY after the fan-out + lifecycle flip succeed, so
    // a failure here leaves the event unprocessed and the outbox sweeper
    // re-drives it.
    // The has-and-add MUST stay synchronous (before the first await) so a
    // same-tick duplicate emitted while this delivery is in flight is
    // skipped rather than double-processed.
    if (this.inflight.has(event.id)) {
      return; // concurrent duplicate of an in-flight delivery (see field doc)
    }
    this.inflight.add(event.id);
    try {
      if (await this.dedup.has('livestock-recall-notifications', event.id)) {
        return;
      }
      const payload = event.payload as {
        recallId: string;
        reason: string;
        animalIds: string[];
        ownerUserIds: string[];
      };
      for (const ownerUserId of payload.ownerUserIds) {
        const animalCount = payload.animalIds.length;
        try {
          await this.notifications.send({
            userId: ownerUserId,
            channel: 'in_app',
            title: 'Livestock recall notice',
            body:
              `Recall ${payload.recallId} affects ${animalCount} animal(s) in your custody. ` +
              `Reason: ${payload.reason}. Isolate the animals and await veterinary instructions.`
          });
        } catch (error) {
          this.logger.warn(
            `recall ${payload.recallId}: notification to '${ownerUserId}' failed: ${(error as Error).message}`
          );
        }
      }
      await this.health.markRecallNotified(payload.recallId);
      // Mark-after: the event is recorded as processed ONLY now. A throw
      // above (including from markRecallNotified) skips this line, so the
      // sweeper redrives the event instead of it being permanently
      // suppressed.
      await this.dedup.mark('livestock-recall-notifications', event.id);
    } finally {
      this.inflight.delete(event.id);
    }
  }
}
