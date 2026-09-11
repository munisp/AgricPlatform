import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPriceWireRepository } from '../../src/database/repositories/price-wire.pg-repository.js';
import type { PriceSubscription } from '../../src/database/repositories/price-wire.repository.js';

/**
 * PostgreSQL contract suite for the Price Wire repositories (Stage 27,
 * innovation 11; migration 069_price_subscriptions.sql). Skipped unless
 * DATABASE_URL points at a database; the migration is applied idempotently
 * by the suite itself (twice — proving re-apply safety).
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform
 *     npx vitest run test/pg/price-wire.pg.spec.ts
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
  '069_price_subscriptions.sql'
);

function subscription(id: string, overrides: Partial<PriceSubscription> = {}): PriceSubscription {
  const now = new Date().toISOString();
  return {
    id,
    userId: `pgtest-user-${id}`,
    commodity: 'maize',
    marketId: 'Dawanau',
    channel: 'sms',
    cadence: 'weekly',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM advisory.price_dispatches WHERE subscription_id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM advisory.price_subscriptions WHERE id LIKE 'pgtest-%'`);
}

describePg('pg price-wire repositories (migration 069 contract)', () => {
  const repo = createPgPriceWireRepository(pool!);

  beforeAll(async () => {
    // The advisory schema is owned by earlier migrations (006_market_data);
    // the harness creates it so this suite also runs standalone.
    await pool!.query('CREATE SCHEMA IF NOT EXISTS advisory');
    // Idempotency proof: applying the migration twice must not error.
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
    await clean();
  });

  afterAll(async () => {
    await clean();
    await pool!.end();
  });

  it('round-trips a subscription and enforces the spec UNIQUE dedupe key', async () => {
    const sub = subscription('pgtest-sub-1');
    await repo.createSubscription(sub);
    const loaded = await repo.getSubscriptionById(sub.id);
    expect(loaded).toMatchObject({
      userId: sub.userId,
      commodity: 'maize',
      marketId: 'Dawanau',
      channel: 'sms',
      cadence: 'weekly',
      status: 'active'
    });
    // Duplicate (user, commodity, market, channel) — even STOPPED rows hold
    // the key, so a duplicate insert is a unique-violation → 409.
    await expect(
      repo.createSubscription(subscription('pgtest-sub-2', { userId: sub.userId }))
    ).rejects.toThrow(/already exists/);
    // A different channel is a distinct subscription.
    await expect(
      repo.createSubscription(
        subscription('pgtest-sub-3', { userId: sub.userId, channel: 'whatsapp' })
      )
    ).resolves.toMatchObject({ channel: 'whatsapp' });
  });

  it('stop is guarded and replay-safe; revive updates the stopped row in place', async () => {
    const sub = subscription('pgtest-sub-10');
    await repo.createSubscription(sub);
    const stopped = await repo.stopSubscription(sub.id);
    expect(stopped.status).toBe('stopped');
    // Replay: no error, still stopped.
    expect((await repo.stopSubscription(sub.id)).status).toBe('stopped');
    // Revive (the service path for re-subscription under the full UNIQUE key).
    const revived = await repo.updateSubscription(sub.id, {
      status: 'active',
      cadence: 'daily',
      updatedAt: new Date().toISOString()
    });
    expect(revived).toMatchObject({ status: 'active', cadence: 'daily' });
  });

  it('findByDedupeKey finds the row regardless of status', async () => {
    const sub = subscription('pgtest-sub-15');
    await repo.createSubscription(sub);
    await repo.stopSubscription(sub.id);
    const found = await repo.findByDedupeKey(sub.userId, 'maize', 'Dawanau', 'sms');
    expect(found?.id).toBe(sub.id);
    expect(found?.status).toBe('stopped');
  });

  it('listDueForDispatch honours status, channel, cadence and the cutoffs', async () => {
    const now = Date.now();
    await repo.createSubscription(subscription('pgtest-sub-20')); // active sms, never sent
    await repo.createSubscription(subscription('pgtest-sub-21', { channel: 'ussd' })); // pull-only
    await repo.createSubscription(
      subscription('pgtest-sub-22', {
        cadence: 'daily',
        lastSentAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString()
      })
    ); // daily, sent 2d ago → due
    await repo.createSubscription(
      subscription('pgtest-sub-23', {
        commodity: 'rice',
        lastSentAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString()
      })
    ); // weekly, sent 2d ago → NOT due
    const due = await repo.listDueForDispatch(
      new Date(now - 24 * 3600 * 1000).toISOString(),
      new Date(now - 7 * 24 * 3600 * 1000).toISOString()
    );
    const dueIds = due.map((sub) => sub.id);
    expect(dueIds).toContain('pgtest-sub-20');
    expect(dueIds).toContain('pgtest-sub-22');
    expect(dueIds).not.toContain('pgtest-sub-21');
    expect(dueIds).not.toContain('pgtest-sub-23');
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
      detail: 'feed keys absent (provider port is stub)',
      createdAt: now
    });
    const delivered = {
      id: 'pgtest-dsp-2',
      subscriptionId: sub.id,
      quoteAsOf: '2026-06-12T06:00:00.000Z',
      bodyHash: 'hash-a',
      channel: 'sms' as const,
      basis: 'live' as const,
      deliveryStatus: 'delivered' as const,
      createdAt: now,
      sentAt: now
    };
    await repo.recordDispatch(delivered);
    await expect(repo.hasDeliveredBody(sub.id, 'hash-a')).resolves.toBe(true);
    // Same body delivered twice → partial unique index → 409.
    await expect(repo.recordDispatch({ ...delivered, id: 'pgtest-dsp-3' })).rejects.toThrow(
      /already delivered/
    );
    // A failed attempt for the same body is allowed (retry path stays open).
    await expect(
      repo.recordDispatch({ ...delivered, id: 'pgtest-dsp-4', deliveryStatus: 'failed', sentAt: undefined })
    ).resolves.toMatchObject({ deliveryStatus: 'failed' });
    const history = await repo.dispatchesFor(sub.id);
    expect(history.map((d) => d.id)).toEqual(['pgtest-dsp-1', 'pgtest-dsp-2', 'pgtest-dsp-4']);
    expect(history[0]).toMatchObject({ basis: 'unavailable', deliveryStatus: 'suppressed' });
    expect(history[1].quoteAsOf).toBe('2026-06-12T06:00:00.000Z');
  });

  it('CHECK constraints reject invalid channel/cadence/status/basis values', async () => {
    await expect(
      repo.createSubscription(subscription('pgtest-sub-40', { channel: 'pigeon' as never }))
    ).rejects.toThrow();
    await expect(
      repo.createSubscription(subscription('pgtest-sub-41', { cadence: 'hourly' as never }))
    ).rejects.toThrow();
    const sub = subscription('pgtest-sub-42');
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
