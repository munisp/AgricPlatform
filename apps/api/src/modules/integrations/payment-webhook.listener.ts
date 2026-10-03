import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { PAYMENT_WEBHOOK_EVENT_REPOSITORY } from '../../database/persistence.tokens.js';
import {
  paymentWebhookEventRow,
  type PaymentWebhookEventRepository
} from '../../database/repositories/payment-webhook-event.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { ADAPTER_DEFINITIONS } from './adapters.js';

/**
 * Payment-capability providers, derived from the single source of truth
 * (ADAPTER_DEFINITIONS capability 'payments') — today paystack and
 * flutterwave. The listener NEVER hard-codes a provider list of its own.
 */
export const PAYMENT_WEBHOOK_PROVIDERS: ReadonlySet<string> = new Set(
  ADAPTER_DEFINITIONS.filter((adapter) => adapter.capability === 'payments').map(
    (adapter) => adapter.provider
  )
);

/**
 * Payment webhook reconciliation listener (GAP-L05). Verified
 * paystack/flutterwave webhooks were published as
 * `integration.webhook.received` with NO domain consumer: a payment
 * callback left no durable trail beyond the generic inbound_events audit
 * row, so nothing could ever reconcile it. This listener is the minimal,
 * fail-closed consumer: it persists the RAW verified payload plus a
 * reconciliation `status` ('received') into
 * integrations.payment_webhook_events, atomically deduped on
 * (provider, dedupe_key). It deliberately contains NO business logic — it
 * never touches escrows, orders, or ledgers; matching a callback to a
 * payment is a separate, auditable reconciliation step.
 *
 * Dedup doctrine (GAP-M09): mark-AFTER-persist via the shared
 * EventDedupService, so an outbox-sweeper re-drive of an already-recorded
 * callback is a no-op while a failed persist stays unrecorded and is
 * re-driven. The store's (provider, dedupe_key) uniqueness is the second
 * replay fence for provider-side retries.
 */
@Injectable()
export class PaymentWebhookReconciliationListener implements OnModuleInit {
  private readonly logger = new Logger(PaymentWebhookReconciliationListener.name);

  constructor(
    private readonly events: DomainEventsService,
    @Inject(PAYMENT_WEBHOOK_EVENT_REPOSITORY)
    private readonly store: PaymentWebhookEventRepository,
    // @Optional: unit specs construct the listener directly; Nest injects
    // the shared EventDedupService (events.processed_events) at runtime.
    @Optional()
    private readonly dedup: EventDedupService = new EventDedupService(
      createInMemoryProcessedEventRepository()
    )
  ) {}

  onModuleInit(): void {
    this.events.on('integration.webhook.received', (event) => {
      const payload = event.payload as { provider?: string; payload?: unknown };
      const provider = payload.provider;
      if (!provider || !PAYMENT_WEBHOOK_PROVIDERS.has(provider)) {
        return;
      }
      void this.dedup
        .runOnce('payment-webhook-reconciliation', event.id, () =>
          this.record(provider, payload.payload)
        )
        .catch((error: unknown) => {
          // Fail-closed: the failure is logged loudly and the event stays
          // unrecorded in processed_events, so the sweeper re-drives it.
          this.logger.error(
            `payment webhook reconciliation failed for ${payload.provider} (event ${event.id}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    });
  }

  /**
   * Persists one verified payment callback. Exported for direct tests.
   * Returns true when the row was recorded, false when the (provider,
   * dedupeKey) pair was already recorded (provider-side retry replay).
   */
  async record(provider: string, payload: unknown): Promise<boolean> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const { eventType, reference } = extractPaymentWebhookIdentity(body);
    // Dedupe key: the provider payment reference when extractable, else a
    // content hash — a reference-less retry of the identical body replays
    // as a no-op either way.
    const dedupeKey =
      reference ?? createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const recorded = await this.store.tryRecord(
      paymentWebhookEventRow(provider, eventType, reference, body),
      dedupeKey
    );
    if (!recorded) {
      this.logger.log(
        `payment webhook already recorded for ${provider} (dedupe ${dedupeKey.slice(0, 12)}…) — replay skipped`
      );
    }
    return recorded;
  }
}

/**
 * Provider-shape identity extraction — documented heuristics, never
 * invented semantics: paystack carries `event` + `data.reference`;
 * flutterwave carries `event`/`event.type` + `data.tx_ref` (fallback
 * `data.flw_ref`). Anything else is 'unknown'/null and still persisted raw.
 */
export function extractPaymentWebhookIdentity(
  payload: Record<string, unknown>
): { eventType: string; reference: string | null } {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const event =
    (payload.event as string | undefined) ??
    (payload['event.type'] as string | undefined) ??
    'unknown';
  const reference =
    (data.reference as string | undefined) ??
    (data.tx_ref as string | undefined) ??
    (data.flw_ref as string | undefined) ??
    null;
  return { eventType: event, reference };
}

/** Typed alias so the coverage registry can reference the listener event. */
export const PAYMENT_WEBHOOK_LISTENER_EVENT: DomainEvent['name'] = 'integration.webhook.received';
