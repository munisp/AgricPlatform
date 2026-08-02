import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LivestockHealthService } from './livestock-health.service.js';

/**
 * Recall fan-out (wave L1b, blueprint F4.2 — 24-hour traceback). Listens for
 * `livestock.recall.initiated`, notifies every affected owner in-app, then
 * flips the case initiated → notified so it can be resolved. Delivery
 * failures are logged and never block the lifecycle flip — the recall case
 * itself is the auditable record, and undelivered messages stay visible in
 * the notification log.
 */
@Injectable()
export class RecallNotificationsListener implements OnModuleInit {
  private readonly logger = new Logger(RecallNotificationsListener.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly health: LivestockHealthService
  ) {}

  onModuleInit(): void {
    this.events.on('livestock.recall.initiated', (event: DomainEvent) => {
      void this.handleRecallInitiated(event).catch((error) =>
        this.logger.warn(`recall notification fan-out failed: ${(error as Error).message}`)
      );
    });
  }

  private async handleRecallInitiated(event: DomainEvent): Promise<void> {
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
  }
}
