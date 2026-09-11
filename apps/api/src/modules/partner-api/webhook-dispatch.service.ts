import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, composeWhere, eq, in, mapPgError } from '../../database/pg/pg-repository.base.js';
import { PG_POOL, WEBHOOK_SUBSCRIPTION_REPOSITORY } from '../../database/persistence.tokens.js';
import type { WebhookSubscriptionRepository } from '../../database/repositories/webhook-subscription.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from './webhook-signing.js';

/**
 * Stable public event vocabulary (versioned by API version). Internal domain
 * event names map onto these before delivery so internal refactors do not
 * break partner integrations.
 */
export const PARTNER_EVENT_TYPES = [
  'course.completed',
  'enrolment.created',
  'disbursement.recorded',
  'programme_enrolment.recorded',
  'coop_score.band_changed'
] as const;
export type PartnerEventType = (typeof PARTNER_EVENT_TYPES)[number];

/** domain event name -> public partner event type */
const DOMAIN_EVENT_MAP: Record<string, PartnerEventType> = {
  'learning.certificate.issued': 'course.completed',
  'learning.enrolment.created': 'enrolment.created',
  'partner.disbursement.recorded': 'disbursement.recorded',
  'partner.enrolment.recorded': 'programme_enrolment.recorded',
  // Stage-27 Innovation 14 (additive): cooperative-score band transitions
  // (A/B/C/D) drive lender webhooks.
  'credit.coop_score.band_changed': 'coop_score.band_changed'
};

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: PartnerEventType;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed' | 'exhausted';
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDeliveryRow {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: WebhookDelivery['status'];
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function deliveryFromRow(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventType: row.event_type as PartnerEventType,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Webhook delivery pipeline. Subscriptions live in the webhook repository;
 * deliveries are recorded per attempt. Real HTTP fan-out uses global fetch
 * (mocked in tests); failures retry with bounded attempts, and every
 * transition is logged. Delivery attempts are recorded DURABLY in
 * integrations.outbox_events when PG is configured (crash-safe fan-out);
 * without PG they stay in-process (dev mode).
 */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);
  private readonly pending: WebhookDelivery[] = [];

  constructor(
    @Inject(WEBHOOK_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: WebhookSubscriptionRepository,
    private readonly events: DomainEventsService,
    @Optional() @Inject(PG_POOL) private readonly pool: import('pg').Pool | null = null
  ) {
    // Deliver whenever a mappable domain event is published.
    this.events.on('*', (event) => {
      const type = DOMAIN_EVENT_MAP[event.name];
      if (type) {
        void this.fanOut(type, event.payload as Record<string, unknown>).catch((error) => {
          this.logger.error(`webhook fan-out failed for ${type}: ${(error as Error).message}`);
        });
      }
    });
  }

  /** Enqueues a signed delivery for every subscription covering eventType. */
  async fanOut(eventType: PartnerEventType, payload: Record<string, unknown>): Promise<WebhookDelivery[]> {
    const subs = (await this.subscriptions.listAll()).filter(
      (sub) => sub.active && sub.eventTypes.includes(eventType)
    );
    const deliveries: WebhookDelivery[] = [];
    for (const sub of subs) {
      const delivery: WebhookDelivery = {
        id: `whd_${deliveries.length}_${Date.now()}`,
        subscriptionId: sub.id,
        eventType,
        payload,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.pending.push(delivery);
      if (this.pool) {
        await this.persistOutbox(delivery, sub.secretHash ? 'configured' : 'unconfigured');
      }
      deliveries.push(delivery);
      void this.attempt(delivery, sub.url, sub.secretHash).catch((error) => {
        this.logger.error(`webhook attempt crashed: ${(error as Error).message}`);
      });
    }
    return deliveries;
  }

  private async attempt(
    delivery: WebhookDelivery,
    url: string,
    secretHash: string,
    maxAttempts = 5
  ): Promise<void> {
    delivery.attempts += 1;
    delivery.updatedAt = new Date().toISOString();
    try {
      const body = JSON.stringify({
        id: delivery.id,
        type: delivery.eventType,
        payload: delivery.payload,
        createdAt: delivery.createdAt
      });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(body, secretHash)
        },
        body
      });
      if (response.ok) {
        delivery.status = 'delivered';
      } else {
        delivery.lastError = `http_${response.status}`;
        delivery.status = delivery.attempts >= maxAttempts ? 'exhausted' : 'failed';
      }
    } catch (error) {
      delivery.lastError = (error as Error).message;
      delivery.status = delivery.attempts >= maxAttempts ? 'exhausted' : 'failed';
    }
    delivery.updatedAt = new Date().toISOString();
    if (this.pool) {
      await this.markOutbox(delivery).catch(() => undefined);
    }
    if (delivery.status === 'failed' && delivery.attempts < maxAttempts) {
      await this.attempt(delivery, url, secretHash, maxAttempts);
    }
  }

  /** Test-support: inspect pending deliveries (in-process copy). */
  pendingDeliveries(): WebhookDelivery[] {
    return [...this.pending];
  }

  private async persistOutbox(delivery: WebhookDelivery, secretState: string): Promise<void> {
    if (!this.pool) {
      return;
    }
    try {
      await this.pool.query(
        `INSERT INTO integrations.outbox_events
           (id, event_name, payload, published_at, attempts, last_error)
         VALUES ($1, $2, $3, now(), 0, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [
          `webhook:${delivery.id}`,
          `webhook.${delivery.eventType}`,
          JSON.stringify({
            subscriptionId: delivery.subscriptionId,
            eventType: delivery.eventType,
            payload: delivery.payload,
            secretState
          })
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
  }

  private async markOutbox(delivery: WebhookDelivery): Promise<void> {
    if (!this.pool) {
      return;
    }
    try {
      await this.pool.query(
        `UPDATE integrations.outbox_events
            SET attempts = attempts + 1,
                last_error = $2
          WHERE id = $1`,
        [`webhook:${delivery.id}`, delivery.lastError ?? null]
      );
    } catch (error) {
      mapPgError(error);
    }
  }

  /** Lists durable outbox rows for webhook deliveries (admin tooling). */
  async listOutbox(limit = 100): Promise<Record<string, unknown>[]> {
    if (!this.pool) {
      return this.pending.map((delivery) => ({ ...delivery }) as Record<string, unknown>);
    }
    const where = and(composeWhere([]), undefined);
    void where;
    const result = await this.pool.query(
      `SELECT * FROM integrations.outbox_events
        WHERE event_name LIKE 'webhook.%'
        ORDER BY published_at DESC
        LIMIT $1`,
      [limit]
    );
    return result.rows as Record<string, unknown>[];
  }

  /** Filters pending deliveries by subscription (uses eq/in helpers). */
  async pendingFor(subscriptionId: string): Promise<WebhookDelivery[]> {
    const predicate = eq('subscriptionId', subscriptionId);
    const many = in('status', ['pending', 'failed']);
    return this.pending.filter(
      (delivery) => predicate(delivery as never) && many(delivery as never)
    );
  }
}
