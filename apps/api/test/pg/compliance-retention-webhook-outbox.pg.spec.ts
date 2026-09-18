import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPgInboundEventRepository } from '../../src/database/repositories/phase3.pg-repository.js';
import { createPgOutboxRepository } from '../../src/database/repositories/core.pg-repository.js';
import { createPgRetentionPolicyRepository } from '../../src/database/repositories/compliance.pg-repository.js';

/**
 * V-27: pg behaviour of the webhook/outbox retention sweeper operations
 * (migration 118 policies over integrations.inbound_events and
 * events.outbox). Mirrors the in-memory contract: processed/published rows
 * past the cutoff are payload-tombstoned (anonymize) or hard-pruned
 * (purge); recent and unprocessed/unpublished rows are always retained.
 * Skipped unless DATABASE_URL points at a database with all migrations
 * applied:
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const DAYS = 86_400_000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAYS).toISOString();

describePg('pg V-27 webhook/outbox retention ops', () => {
  const inbound = () => createPgInboundEventRepository(pool!);
  const outbox = () => createPgOutboxRepository(pool!);
  const policies = () => createPgRetentionPolicyRepository(pool!);

  async function cleanRows(): Promise<void> {
    if (!pool) return;
    await pool.query(`DELETE FROM integrations.inbound_events WHERE id LIKE 'contract-v27-%'`);
    await pool.query(`DELETE FROM events.outbox WHERE id LIKE 'contract-v27-%'`);
  }

  beforeAll(cleanRows);
  afterEach(cleanRows);

  it('migration 118 seeds the webhook/outbox retention policies', async () => {
    if (!pool) return;
    const seeded = await policies().list();
    expect(seeded.find((p) => p.entity === 'integrations.inbound_events')).toMatchObject({
      retainDays: 90,
      anonymizeNotDelete: true
    });
    expect(seeded.find((p) => p.entity === 'events.outbox')).toMatchObject({
      retainDays: 90,
      anonymizeNotDelete: false
    });
  });

  it('inbound_events: count → payload tombstone (idempotent) → purge; recent/unprocessed retained', async () => {
    if (!pool) return;
    await inbound().ingest({
      id: 'contract-v27-inb-old',
      system: 'lender',
      eventType: 'loan_event',
      dedupeKey: 'contract-v27-evt-1',
      payload: { nin: '12345678901' },
      receivedAt: isoDaysAgo(120),
      processedAt: isoDaysAgo(100)
    });
    await inbound().ingest({
      id: 'contract-v27-inb-recent',
      system: 'farmos',
      eventType: 'crop_plan',
      dedupeKey: 'contract-v27-evt-2',
      payload: { field: 'north-1' },
      receivedAt: isoDaysAgo(12),
      processedAt: isoDaysAgo(10)
    });
    await inbound().ingest({
      id: 'contract-v27-inb-pending',
      system: 'lender',
      eventType: 'provider_webhook',
      dedupeKey: 'contract-v27-evt-3',
      payload: { nin: '10987654321' },
      receivedAt: isoDaysAgo(400)
    });

    const cutoff = isoDaysAgo(90);
    expect(await inbound().countProcessedBefore(cutoff)).toBe(1);

    // Anonymize tombstones the payload (jsonb NOT NULL → '{}', never NULL).
    expect(await inbound().anonymizeProcessedBefore(cutoff)).toBe(1);
    const scrubbed = await inbound().findById('contract-v27-inb-old');
    expect(scrubbed?.payload).toEqual({});
    expect(scrubbed?.dedupeKey).toBe('contract-v27-evt-1');
    expect(scrubbed?.processedAt).toBeDefined();
    // Second pass is a no-op.
    expect(await inbound().anonymizeProcessedBefore(cutoff)).toBe(0);
    // Purge removes the row; recent + unprocessed survive.
    expect(await inbound().purgeProcessedBefore(cutoff)).toBe(1);
    expect(await inbound().findById('contract-v27-inb-old')).toBeUndefined();
    expect(await inbound().findById('contract-v27-inb-recent')).toBeDefined();
    expect((await inbound().findById('contract-v27-inb-pending'))?.payload).toEqual({
      nin: '10987654321'
    });
  });

  it('events.outbox: count → purge published-old; recent/unpublished retained', async () => {
    if (!pool) return;
    await outbox().append({
      id: 'contract-v27-evt-old',
      name: 'partner.disbursement.recorded',
      payload: { partnerId: 'p1', userId: 'u1' },
      occurredAt: isoDaysAgo(120)
    });
    await outbox().append({
      id: 'contract-v27-evt-recent',
      name: 'partner.disbursement.recorded',
      payload: { partnerId: 'p1' },
      occurredAt: isoDaysAgo(12)
    });
    await outbox().append({
      id: 'contract-v27-evt-pending',
      name: 'partner.disbursement.recorded',
      payload: { partnerId: 'p1' },
      occurredAt: isoDaysAgo(400)
    });
    await outbox().markPublished('contract-v27-evt-old', isoDaysAgo(100));
    await outbox().markPublished('contract-v27-evt-recent', isoDaysAgo(10));

    const cutoff = isoDaysAgo(90);
    expect(await outbox().countPublishedBefore(cutoff)).toBe(1);

    // Anonymize path (operator-flipped policy): payload tombstoned, row kept.
    expect(await outbox().anonymizePublishedBefore(cutoff)).toBe(1);
    const [record] = (await outbox().listRecords()).filter(
      (r) => r.event.id === 'contract-v27-evt-old'
    );
    expect(record.event.payload).toEqual({});
    expect(record.publishedAt).toBeDefined();
    expect(await outbox().anonymizePublishedBefore(cutoff)).toBe(0);

    // Default policy path: hard prune.
    expect(await outbox().purgePublishedBefore(cutoff)).toBe(1);
    const remaining = (await outbox().listRecords()).map((r) => r.event.id);
    expect(remaining).not.toContain('contract-v27-evt-old');
    expect(remaining).toContain('contract-v27-evt-recent');
    expect(remaining).toContain('contract-v27-evt-pending'); // unpublished never in scope
  });
});
