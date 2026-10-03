import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPgProcessedEventRepository } from '../../../src/database/repositories/platform.pg-repository.js';
import { createPgPaymentWebhookEventRepository } from '../../../src/database/repositories/payment-webhook-event.pg-repository.js';
import { paymentWebhookEventRow } from '../../../src/database/repositories/payment-webhook-event.repository.js';
import { PgOutboxRepository } from '../../../src/database/repositories/outbox.pg-repository.js';

/**
 * GAP-L05/GAP-L11 pg integration: the new durable stores behave atomically
 * against a real database (skipped when TEST_DATABASE_URL is unset — the
 * unit suites cover the in-memory drivers).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

maybe('pg durable stores (GAP-L05 payment webhooks, GAP-L11 processed events)', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  it('payment webhook events: tryRecord is atomic on (provider, dedupe_key)', async () => {
    const repo = createPgPaymentWebhookEventRepository(pool);
    const row = paymentWebhookEventRow('paystack', 'charge.success', `REF-${Date.now()}`, {
      event: 'charge.success'
    });
    expect(await repo.tryRecord(row, row.reference!)).toBe(true);
    expect(await repo.tryRecord(row, row.reference!)).toBe(false);
    const listed = await repo.listRecent('paystack', 5);
    expect(listed[0]).toMatchObject({
      provider: 'paystack',
      eventType: 'charge.success',
      reference: row.reference,
      status: 'received'
    });
  });

  it('processed events: tryRecord dedupes and retention purge is batched oldest-first', async () => {
    const repo = createPgProcessedEventRepository(pool);
    const consumer = `spec-${Date.now()}`;
    expect(await repo.tryRecord(consumer, 'e1')).toBe(true);
    expect(await repo.tryRecord(consumer, 'e1')).toBe(false);
    expect(await repo.has(consumer, 'e1')).toBe(true);

    // Seed old rows directly for the retention path.
    await pool.query(
      `INSERT INTO events.processed_events (consumer, event_id, processed_at)
       VALUES ($1, 'old-1', now() - interval '100 days'),
              ($1, 'old-2', now() - interval '100 days'),
              ($1, 'new-1', now())`,
      [consumer]
    );
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(await repo.countProcessedBefore(cutoff)).toBe(2);
    expect(await repo.purgeProcessedBefore(cutoff, 1)).toBe(1);
    expect(await repo.countProcessedBefore(cutoff)).toBe(1);
    expect(await repo.purgeProcessedBefore(cutoff, 500)).toBe(1);
    expect(await repo.has(consumer, 'new-1')).toBe(true);
  });

  it('outbox pending reads are bounded and ordered oldest-first (GAP-L03)', async () => {
    const repo = new PgOutboxRepository(pool);
    const pending = await repo.listPendingRecords(5, 0);
    expect(pending.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < pending.length; i += 1) {
      expect(pending[i].event.occurredAt >= pending[i - 1].event.occurredAt).toBe(true);
    }
  });
});
