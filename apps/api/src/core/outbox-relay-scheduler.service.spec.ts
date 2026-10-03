import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createInMemoryOutboxRepository } from '../database/repositories/outbox.repository.js';
import { DomainEventsService, type DomainEvent } from './domain-events.service.js';
import {
  OUTBOX_RELAY_INTERVAL_MS,
  OUTBOX_RELAY_LOCK_KEY,
  OutboxRelaySchedulerService,
  outboxRelayEnabled
} from './outbox-relay-scheduler.service.js';
import { OutboxSweeperService } from './outbox-sweeper.service.js';

function build(env: NodeJS.ProcessEnv = {}) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const sweeper = new OutboxSweeperService(events, outbox);
  const scheduler = new OutboxRelaySchedulerService(sweeper, null, env);
  return { outbox, events, sweeper, scheduler };
}

async function seedStalled(outbox: ReturnType<typeof createInMemoryOutboxRepository>) {
  const event: DomainEvent = {
    id: 'event-relay-spec',
    name: 'advisory.content.published',
    payload: { advisoryId: 'a1' },
    occurredAt: new Date().toISOString()
  };
  await outbox.append(event);
  return event;
}

describe('outboxRelayEnabled (GAP-M03)', () => {
  it('defaults ON outside production (the relay must never silently stop)', () => {
    expect(outboxRelayEnabled({})).toBe(true);
    expect(outboxRelayEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(outboxRelayEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('defaults OFF in production, where the default-deployed CronJob drives the sweep', () => {
    expect(outboxRelayEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  it('honours the explicit flag both ways', () => {
    expect(outboxRelayEnabled({ OUTBOX_RELAY_ENABLED: 'true', NODE_ENV: 'production' })).toBe(true);
    expect(outboxRelayEnabled({ OUTBOX_RELAY_ENABLED: 'false' })).toBe(false);
    expect(outboxRelayEnabled({ OUTBOX_RELAY_ENABLED: ' FALSE ' })).toBe(false);
  });
});

describe('OutboxRelaySchedulerService', () => {
  it('does not start a timer when disabled', () => {
    const { scheduler } = build({ OUTBOX_RELAY_ENABLED: 'false' });
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    scheduler.onModuleInit();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('starts a jittered timer when enabled and clears it on destroy', () => {
    const { scheduler } = build({});
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    scheduler.onModuleInit();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const delay = setTimeoutSpy.mock.calls[0][1] as number;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(OUTBOX_RELAY_INTERVAL_MS);
    setTimeoutSpy.mockRestore();
    scheduler.onModuleDestroy();
  });

  it('sweepOnce runs the outbox sweep (single-process mode)', async () => {
    const { scheduler, outbox } = build();
    await seedStalled(outbox);
    const result = await scheduler.sweepOnce();
    expect(result).not.toBe('skipped');
    expect((result as { published: number }).published).toBe(1);
    // Second pass: nothing left to relay.
    expect(((await scheduler.sweepOnce()) as { published: number }).published).toBe(0);
  });

  it('skips a pass while another same-process pass is in flight', async () => {
    const { scheduler, outbox } = build();
    await seedStalled(outbox);
    // Hold the in-process guard by starting a pass whose sweep we block.
    const blocked = scheduler.sweepOnce();
    // The first call sets `running` synchronously before its first await.
    expect(await scheduler.sweepOnce()).toBe('skipped');
    await blocked;
  });

  it('single-writer: skips when a peer replica holds the pg advisory lock', async () => {
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    const sweeper = new OutboxSweeperService(events, outbox);
    const queries: string[] = [];
    const client = {
      query: vi.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [{ locked: false }] });
      }),
      release: vi.fn()
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
    const scheduler = new OutboxRelaySchedulerService(sweeper, pool, {});
    await seedStalled(outbox);

    expect(await scheduler.sweepOnce()).toBe('skipped');
    expect(client.release).toHaveBeenCalledTimes(1);
    // Only the lock attempt ran — no sweep, no unlock.
    expect(queries).toEqual(['SELECT pg_try_advisory_lock($1) AS locked']);
  });

  it('single-writer: sweeps under the advisory lock and always unlocks', async () => {
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    const sweeper = new OutboxSweeperService(events, outbox);
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [{ locked: true }] });
      }),
      release: vi.fn()
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
    const scheduler = new OutboxRelaySchedulerService(sweeper, pool, {});
    await seedStalled(outbox);

    const result = await scheduler.sweepOnce();
    expect((result as { published: number }).published).toBe(1);
    expect(queries.map((q) => q.sql)).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked',
      'SELECT pg_advisory_unlock($1)'
    ]);
    expect(queries[0].params).toEqual([OUTBOX_RELAY_LOCK_KEY]);
    expect(queries[1].params).toEqual([OUTBOX_RELAY_LOCK_KEY]);
    expect(client.release).toHaveBeenCalledTimes(1);
    // Guard released: a later pass runs again.
    expect(((await scheduler.sweepOnce()) as { published: number }).published).toBe(0);
  });
});
