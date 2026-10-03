import { beforeEach, describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryPaymentWebhookEventRepository } from '../../database/repositories/payment-webhook-event.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import {
  PAYMENT_WEBHOOK_PROVIDERS,
  PaymentWebhookReconciliationListener,
  extractPaymentWebhookIdentity
} from './payment-webhook.listener.js';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const paystackCharge = {
  event: 'charge.success',
  data: { reference: 'PSK-REF-001', amount: 500000, currency: 'NGN' }
};

describe('PaymentWebhookReconciliationListener (GAP-L05)', () => {
  let events: DomainEventsService;
  let store: ReturnType<typeof createInMemoryPaymentWebhookEventRepository>;
  let listener: PaymentWebhookReconciliationListener;

  beforeEach(() => {
    events = new DomainEventsService(createInMemoryOutboxRepository());
    store = createInMemoryPaymentWebhookEventRepository();
    listener = new PaymentWebhookReconciliationListener(
      events,
      store,
      new EventDedupService(createInMemoryProcessedEventRepository())
    );
    listener.onModuleInit();
  });

  it('derives the payment provider set from ADAPTER_DEFINITIONS (no hard-coded list)', () => {
    expect([...PAYMENT_WEBHOOK_PROVIDERS].sort()).toEqual(['flutterwave', 'paystack']);
  });

  it('persists a verified paystack callback raw, with status received', async () => {
    await events.publish('integration.webhook.received', {
      provider: 'paystack',
      payload: paystackCharge
    });
    await flush();
    const rows = await store.listRecent('paystack');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'paystack',
      eventType: 'charge.success',
      reference: 'PSK-REF-001',
      status: 'received',
      payload: paystackCharge
    });
    expect(rows[0].id).toMatch(/^payment-webhook-/);
    expect(rows[0].receivedAt).toBeTruthy();
  });

  it('persists flutterwave callbacks (event + tx_ref shape)', async () => {
    const flw = { event: 'charge.completed', data: { tx_ref: 'FLW-TX-9', flw_ref: 'FLW-9' } };
    await events.publish('integration.webhook.received', { provider: 'flutterwave', payload: flw });
    await flush();
    const rows = await store.listRecent('flutterwave');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: 'charge.completed', reference: 'FLW-TX-9' });
  });

  it('ignores non-payment providers', async () => {
    await events.publish('integration.webhook.received', { provider: 'whatsapp', payload: {} });
    await events.publish('integration.webhook.received', { provider: 'weather', payload: {} });
    await flush();
    expect(await store.listRecent()).toHaveLength(0);
  });

  it('provider-side retry with the same reference replays as a no-op', async () => {
    expect(await listener.record('paystack', paystackCharge)).toBe(true);
    expect(await listener.record('paystack', paystackCharge)).toBe(false);
    expect(await store.listRecent('paystack')).toHaveLength(1);
  });

  it('reference-less callbacks dedupe on the content hash', async () => {
    const body = { data: { id: 123 } };
    expect(await listener.record('paystack', body)).toBe(true);
    expect(await listener.record('paystack', { ...body })).toBe(false);
    const rows = await store.listRecent('paystack');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: 'unknown', reference: null });
  });

  it('sweeper re-drive of the same event id does not re-execute the persist', async () => {
    const event = events.build('integration.webhook.received', {
      provider: 'paystack',
      payload: paystackCharge
    });
    // Two deliveries of the SAME event id (outbox sweeper re-drive).
    events.emit(event);
    events.emit(event);
    await flush();
    expect(await store.listRecent('paystack')).toHaveLength(1);
  });

  it('a persist failure leaves the event unrecorded so the re-drive retries it', async () => {
    const dedup = new EventDedupService(createInMemoryProcessedEventRepository());
    let calls = 0;
    const flaky = {
      tryRecord: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('db blip');
        }
        return true;
      },
      listRecent: async () => []
    };
    const recovering = new PaymentWebhookReconciliationListener(
      events,
      flaky,
      dedup
    );
    recovering.onModuleInit();
    const event = events.build('integration.webhook.received', {
      provider: 'paystack',
      payload: paystackCharge
    });
    events.emit(event);
    await flush();
    expect(calls).toBe(1);
    expect(await dedup.has('payment-webhook-reconciliation', event.id)).toBe(false);
    // Re-drive: the persist now succeeds and the event is recorded.
    events.emit(event);
    await flush();
    expect(calls).toBe(2);
    expect(await dedup.has('payment-webhook-reconciliation', event.id)).toBe(true);
  });
});

describe('extractPaymentWebhookIdentity', () => {
  it('reads the paystack shape', () => {
    expect(extractPaymentWebhookIdentity(paystackCharge)).toEqual({
      eventType: 'charge.success',
      reference: 'PSK-REF-001'
    });
  });

  it('falls back to flw_ref and unknown event', () => {
    expect(extractPaymentWebhookIdentity({ data: { flw_ref: 'FLW-1' } })).toEqual({
      eventType: 'unknown',
      reference: 'FLW-1'
    });
  });

  it('handles an empty payload without inventing identity', () => {
    expect(extractPaymentWebhookIdentity({})).toEqual({ eventType: 'unknown', reference: null });
  });
});
