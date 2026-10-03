import { newId } from '../../common/async-repository.js';

/**
 * GAP-L05: durable payment-webhook reconciliation store
 * (integrations.payment_webhook_events, migration 124).
 *
 * Paystack/Flutterwave webhooks arrive verified via the integrations webhook
 * controller and are fanned out as `integration.webhook.received` — but no
 * domain consumer existed, so a payment callback left no durable
 * reconciliation trail beyond the generic inbound_events audit row. This
 * store is the minimal fail-closed reconciliation structure: the RAW
 * payload plus a reconciliation `status` ('received' until a future
 * reconciliation worker matches it to an escrow/order — deliberately NOT
 * fabricated here), deduped atomically on (provider, dedupe_key).
 */
export interface PaymentWebhookEventRecord {
  id: string;
  provider: string;
  /** Provider-reported event class (e.g. paystack `charge.success`), 'unknown' when absent. */
  eventType: string;
  /** Provider payment reference when extractable (paystack data.reference, flutterwave data.tx_ref), else null. */
  reference: string | null;
  payload: Record<string, unknown>;
  status: 'received' | 'reconciled' | 'ignored';
  receivedAt: string;
}

export interface PaymentWebhookEventRepository {
  /**
   * Atomic insert-if-absent keyed on (provider, dedupeKey)
   * (INSERT ... ON CONFLICT DO NOTHING on pg). Returns true when the row
   * was recorded, false for an already-recorded duplicate — replay-safe by
   * construction.
   */
  tryRecord(record: PaymentWebhookEventRecord, dedupeKey: string): Promise<boolean>;
  /** Newest-first listing for ops inspection and tests, bounded by `limit`. */
  listRecent(provider?: string, limit?: number): Promise<PaymentWebhookEventRecord[]>;
}

export class InMemoryPaymentWebhookEventRepository implements PaymentWebhookEventRepository {
  private readonly rows: Array<{ record: PaymentWebhookEventRecord; dedupeKey: string }> = [];

  async tryRecord(record: PaymentWebhookEventRecord, dedupeKey: string): Promise<boolean> {
    if (
      this.rows.some((row) => row.record.provider === record.provider && row.dedupeKey === dedupeKey)
    ) {
      return false;
    }
    this.rows.push({ record: { ...record }, dedupeKey });
    return true;
  }

  async listRecent(provider?: string, limit = 100): Promise<PaymentWebhookEventRecord[]> {
    return this.rows
      .filter((row) => !provider || row.record.provider === provider)
      .slice()
      .sort((a, b) => b.record.receivedAt.localeCompare(a.record.receivedAt))
      .slice(0, Math.max(0, limit))
      .map((row) => ({ ...row.record }));
  }
}

export function paymentWebhookEventRow(
  provider: string,
  eventType: string,
  reference: string | null,
  payload: Record<string, unknown>
): PaymentWebhookEventRecord {
  return {
    id: newId('payment-webhook'),
    provider,
    eventType,
    reference,
    payload,
    status: 'received',
    receivedAt: new Date().toISOString()
  };
}

export function createInMemoryPaymentWebhookEventRepository(): InMemoryPaymentWebhookEventRepository {
  return new InMemoryPaymentWebhookEventRepository();
}
