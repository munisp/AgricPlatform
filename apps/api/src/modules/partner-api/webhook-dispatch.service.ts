import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { WEBHOOK_SUBSCRIPTION_REPOSITORY } from '../../database/persistence.tokens.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import type {
  WebhookSubscription,
  WebhookSubscriptionRepository
} from '../../database/repositories/partner-api.repository.js';

/**
 * Partner-facing webhook event types. Internal domain events keep their
 * `{domain}.{entity}.{verb}` taxonomy; this map exposes a stable public
 * vocabulary to subscribers.
 */
export const PARTNER_EVENT_TYPES = [
  'course.completed',
  'enrolment.created',
  'disbursement.recorded',
  'programme_enrolment.recorded'
] as const;

export type PartnerEventType = (typeof PARTNER_EVENT_TYPES)[number];

/** Consumer name in events.processed_events for the dispatch dedup ledger. */
export const WEBHOOK_DISPATCH_CONSUMER = 'partner-webhook-dispatch';

const DOMAIN_EVENT_MAP: Record<string, PartnerEventType> = {
  'learning.certificate.issued': 'course.completed',
  'learning.enrolment.created': 'enrolment.created',
  'partner.disbursement.recorded': 'disbursement.recorded',
  'partner.enrolment.recorded': 'programme_enrolment.recorded'
};

export interface WebhookDelivery {
  id: string;
  type: PartnerEventType;
  occurredAt: string;
  data: unknown;
}

export type WebhookFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number }>;

/** HMAC-SHA256 signature over the exact JSON payload (sha256=<hex>). */
export function signWebhookPayload(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

/**
 * Outbound webhook dispatcher (wave P5d). Listens to the domain-event
 * outbox (DomainEventsService already persists every event before fan-out,
 * so deliveries are outbox-style replayable) and POSTs HMAC-signed JSON
 * deliveries to each active subscription matching the event type.
 */
@Injectable()
export class WebhookDispatchService implements OnModuleInit {
  private readonly logger = new Logger(WebhookDispatchService.name);
  private readonly fetchImpl: WebhookFetch;

  constructor(
    private readonly events: DomainEventsService,
    @Inject(WEBHOOK_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: WebhookSubscriptionRepository,
    @Optional() fetchImpl?: WebhookFetch,
    // @Optional: unit specs construct the service directly; Nest injects the
    // shared EventDedupService (events.processed_events) at runtime.
    @Optional()
    private readonly dedup: EventDedupService = new EventDedupService(
      createInMemoryProcessedEventRepository()
    )
  ) {
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as WebhookFetch);
  }

  onModuleInit(): void {
    this.events.on('*', (event: DomainEvent) => {
      const type = DOMAIN_EVENT_MAP[event.name];
      if (type) {
        void this.dispatchOnce(type, event).catch((error: unknown) => {
          this.logger.warn(
            `webhook dispatch for ${event.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
    });
  }

  /**
   * Consumer-side dedup, MARK-AFTER-DISPATCH (audit A4-6): the event is
   * recorded in events.processed_events only after every subscribed delivery
   * succeeded. A failed delivery throws, the event stays unprocessed, and the
   * outbox sweeper re-drives it — dispatch is at-least-once. Receivers dedupe
   * re-deliveries via the stable per-event delivery id (x-agric-delivery).
   * Public: also the outbox-sweeper re-drive entry point.
   */
  async dispatchOnce(type: PartnerEventType, event: DomainEvent): Promise<void> {
    if (await this.dedup.has(WEBHOOK_DISPATCH_CONSUMER, event.id)) {
      return;
    }
    const { delivered, targets } = await this.fanOut(type, event);
    if (delivered < targets) {
      throw new Error(
        `webhook dispatch for event ${event.id}: ${targets - delivered} of ${targets} deliveries failed — left unprocessed for sweeper re-drive`
      );
    }
    await this.dedup.mark(WEBHOOK_DISPATCH_CONSUMER, event.id);
  }

  /** Delivers one partner event to every active subscribed client URL. */
  async dispatch(type: PartnerEventType, event: DomainEvent): Promise<number> {
    return (await this.fanOut(type, event)).delivered;
  }

  /**
   * Fans the event out to all matching active subscriptions. The delivery id
   * is derived from the event id (not regenerated per attempt) so a partner
   * can dedupe a re-driven delivery against the first attempt.
   */
  private async fanOut(
    type: PartnerEventType,
    event: DomainEvent
  ): Promise<{ delivered: number; targets: number }> {
    const active = await this.subscriptions.find({ status: 'active' });
    const targets = active.filter((subscription) => subscription.eventTypes.includes(type));
    const delivery: WebhookDelivery = {
      id: `whd_${event.id}`,
      type,
      occurredAt: event.occurredAt,
      data: event.payload
    };
    const body = JSON.stringify(delivery);
    let delivered = 0;
    for (const subscription of targets) {
      const ok = await this.deliver(subscription, delivery, body);
      if (ok) delivered += 1;
    }
    return { delivered, targets: targets.length };
  }

  /** Signs and POSTs a single delivery. Returns true on a 2xx response. */
  async deliver(
    subscription: WebhookSubscription,
    delivery: WebhookDelivery,
    body = JSON.stringify(delivery)
  ): Promise<boolean> {
    const response = await this.fetchImpl(subscription.targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agric-signature': signWebhookPayload(subscription.secret, body),
        'x-agric-event': delivery.type,
        'x-agric-delivery': delivery.id
      },
      body
    });
    if (response.status < 200 || response.status >= 300) {
      this.logger.warn(
        `webhook ${delivery.id} to ${subscription.targetUrl} returned ${response.status}`
      );
      return false;
    }
    return true;
  }
}
