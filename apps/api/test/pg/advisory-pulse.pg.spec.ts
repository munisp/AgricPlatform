import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAdvisoryPulseRepository } from '../../src/database/repositories/advisory-pulse.pg-repository.js';
import type { PlotAdvisorySubscription } from '../../src/database/repositories/advisory-pulse.repository.js';

/**
 * PostgreSQL contract suite for the Planting-Window Pulse repositories
 * (Stage 27 Batch 1, innovation 4; migration 058_advisory_planting_pulse.sql).
 * Skipped unless DATABASE_URL points at a database; the migration is applied
 * idempotently by the suite itself (twice — proving re-apply safety).
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform
 *     npx vitest run test/pg/advisory-pulse.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '058_advisory_planting_pulse.sql'
);

function subscription(id: string, overrides: Partial<PlotAdvisorySubscription> = {}): PlotAdvisorySubscription {
  const now = new Date().toISOString();
  return {
    id,
    plotId: `pgtest-plot-${id}`,
    userId: `pgtest-user-${id}`,
    channel: 'sms',
    crop: 'maize',
    h3Res9: '8939f1b2b3bffff',
    locale: 'en',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM advisory.advisory_dispatches WHERE subscription_id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM advisory.plot_advisory_subscriptions WHERE id LIKE 'pgtest-%'`);
}

describePg('pg advisory pulse repositories (migration 058 contract)', () => {
  const repo = createPgAdvisoryPulseRepository(pool!);

  beforeAll(async () => {
    // Idempotency proof: applying the migration twice must not error.
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
    await clean();
  });

  afterAll(async () => {
    await clean();
    await pool!.end();
  });

  it('round-trips a subscription and enforces the active dedupe key', async () => {
    const sub = subscription('pgtest-sub-1');
    await repo.createSubscription(sub);
    const loaded = await repo.getSubscriptionById(sub.id);
    expect(loaded).toMatchObject({
      plotId: sub.plotId,
      userId: sub.userId,
      channel: 'sms',
      crop: 'maize',
      h3Res9: '8939f1b2b3bffff',
      status: 'active'
    });
    // Active duplicate (plot, channel, crop) → unique-violation → 409.
    await expect(
      repo.createSubscription(subscription('pgtest-sub-2', { plotId: sub.plotId }))
    ).rejects.toThrow(/already exists/);
    // A different crop on the same plot+channel is a distinct subscription.
    await expect(
      repo.createSubscription(subscription('pgtest-sub-3', { plotId: sub.plotId, crop: 'rice' }))
    ).resolves.toMatchObject({ crop: 'rice' });
  });

  it('stop is guarded and replay-safe; a stopped row frees the dedupe key', async () => {
    const sub = subscription('pgtest-sub-10');
    await repo.createSubscription(sub);
    const stopped = await repo.stopSubscription(sub.id);
    expect(stopped.status).toBe('stopped');
    // Replay: no error, still stopped.
    expect((await repo.stopSubscription(sub.id)).status).toBe('stopped');
    // The key is free again.
    await expect(
      repo.createSubscription(subscription('pgtest-sub-11', { plotId: sub.plotId }))
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('listDueForDispatch honours status, channel and the send-before cutoff', async () => {
    await repo.createSubscription(subscription('pgtest-sub-20')); // active sms, never sent
    await repo.createSubscription(subscription('pgtest-sub-21', { channel: 'ussd' })); // pull-only
    await repo.createSubscription(
      subscription('pgtest-sub-22', { lastSentAt: new Date().toISOString() })
    ); // just sent
    const due = await repo.listDueForDispatch(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
    const dueIds = due.map((sub) => sub.id);
    expect(dueIds).toContain('pgtest-sub-20');
    expect(dueIds).not.toContain('pgtest-sub-21');
    expect(dueIds).not.toContain('pgtest-sub-22');
  });

  it('records dispatches with basis labels; delivered dedupe is unique-enforced', async () => {
    const sub = subscription('pgtest-sub-30');
    await repo.createSubscription(sub);
    const now = new Date().toISOString();
    await repo.recordDispatch({
      id: 'pgtest-dsp-1',
      subscriptionId: sub.id,
      channel: 'sms',
      basis: 'unavailable',
      deliveryStatus: 'suppressed',
      detail: 'weather driver is stub/unconfigured',
      createdAt: now
    });
    const delivered = {
      id: 'pgtest-dsp-2',
      subscriptionId: sub.id,
      windowStart: '2026-06-02',
      bodyHash: 'hash-a',
      channel: 'sms' as const,
      basis: 'live' as const,
      deliveryStatus: 'delivered' as const,
      ruleVersion: 'planting-rules-v1',
      createdAt: now,
      sentAt: now
    };
    await repo.recordDispatch(delivered);
    await expect(repo.hasDeliveredBody(sub.id, 'hash-a')).resolves.toBe(true);
    // Same window delivered twice → partial unique index → 409.
    await expect(repo.recordDispatch({ ...delivered, id: 'pgtest-dsp-3' })).rejects.toThrow(
      /already delivered/
    );
    // A failed attempt for the same body is allowed (retry path stays open).
    await expect(
      repo.recordDispatch({ ...delivered, id: 'pgtest-dsp-4', deliveryStatus: 'failed', sentAt: undefined })
    ).resolves.toMatchObject({ deliveryStatus: 'failed' });
    const history = await repo.dispatchesFor(sub.id);
    expect(history.map((d) => d.id)).toEqual([
      'pgtest-dsp-1',
      'pgtest-dsp-2',
      'pgtest-dsp-4'
    ]);
    expect(history[0]).toMatchObject({ basis: 'unavailable', deliveryStatus: 'suppressed' });
  });

  it('CHECK constraints reject invalid channel/status/basis values', async () => {
    await expect(
      repo.createSubscription(subscription('pgtest-sub-40', { channel: 'pigeon' as never }))
    ).rejects.toThrow();
    const sub = subscription('pgtest-sub-41');
    await repo.createSubscription(sub);
    await expect(
      repo.recordDispatch({
        id: 'pgtest-dsp-40',
        subscriptionId: sub.id,
        channel: 'sms',
        basis: 'fabricated' as never,
        deliveryStatus: 'delivered',
        createdAt: new Date().toISOString()
      })
    ).rejects.toThrow();
  });
});
