import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { ORDER_REPOSITORY } from '../../database/persistence.tokens.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Order-status notification listener (GAP-H05 partial): the first real
 * end-to-end business consumer on the default event path. A
 * delivery-critical transition (`marketplace.order.status_changed` →
 * `delivered` | `completed`) persists an in-app notification for the buyer,
 * so the buyer learns their produce arrived without polling the app.
 *
 * Path: marketplace.service CAS-writes the status with the outbox event in
 * the same transaction; the in-process fan-out runs this listener, and the
 * outbox sweep re-drives it on failure — so the notification is delivered
 * off the default stub bus with no broker dependency.
 *
 * Dedup doctrine (GAP-M09): mark-AFTER-send via the shared
 * EventDedupService — a sweeper re-drive of an already-notified event is a
 * no-op, while a failed send stays unrecorded and is re-driven. A missing
 * order or a buyer who disabled in_app notifications is a SKIP (marked
 * processed): re-driving can never make it notifyable, and skipping is
 * fail-closed (no fabricated recipient, no forced channel).
 */
@Injectable()
export class OrderStatusNotificationsListener implements OnModuleInit {
  private readonly logger = new Logger(OrderStatusNotificationsListener.name);

  /** Delivery-critical target transitions that notify the buyer. */
  private static readonly NOTIFY_TO = new Set(['delivered', 'completed']);

  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    // @Optional: unit specs construct the listener directly; Nest injects
    // the shared EventDedupService (events.processed_events) at runtime.
    @Optional()
    private readonly dedup: EventDedupService = new EventDedupService(
      createInMemoryProcessedEventRepository()
    )
  ) {}

  onModuleInit(): void {
    this.events.on('marketplace.order.status_changed', (event) => {
      const payload = event.payload as { orderId?: string; to?: string };
      if (!payload.orderId || !payload.to || !OrderStatusNotificationsListener.NOTIFY_TO.has(payload.to)) {
        return;
      }
      const { orderId, to } = payload;
      void this.dedup
        .runOnce('notifications-order-status', event.id, () =>
          this.notifyBuyer(orderId, to)
        )
        .catch((error: unknown) => {
          // Fail-closed: logged loudly, event left unrecorded in
          // processed_events so the outbox sweeper re-drives it.
          this.logger.error(
            `order-status notification failed for order ${orderId} (event ${event.id}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    });
  }

  /** Exported for direct tests: notify the buyer of one delivery-critical transition. */
  async notifyBuyer(orderId: string, to: string): Promise<void> {
    const order = await this.orders.findById(orderId);
    if (!order) {
      this.logger.warn(
        `order-status notification skipped: order ${orderId} not found (event will be marked processed)`
      );
      return;
    }
    const preferences = await this.notifications.preferencesFor(order.buyerId);
    const inApp = preferences.find((pref) => pref.channel === 'in_app');
    if (inApp && !inApp.enabled) {
      // The buyer explicitly disabled in_app: honour it (fail-closed — no
      // silent channel substitution) and treat the event as handled.
      this.logger.log(
        `order-status notification skipped: buyer ${order.buyerId} disabled in_app notifications`
      );
      return;
    }
    await this.notifications.send({
      userId: order.buyerId,
      channel: 'in_app',
      title: to === 'delivered' ? 'Order delivered' : 'Order completed',
      body:
        to === 'delivered'
          ? `Order ${orderId} was marked delivered. Confirm receipt to release the escrow.`
          : `Order ${orderId} is complete. Thank you for trading on AgricPlatform.`
    });
  }
}
