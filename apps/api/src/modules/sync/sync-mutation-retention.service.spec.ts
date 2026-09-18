import { describe, expect, it } from 'vitest';
import { InMemorySyncMutationRepository } from '../../database/repositories/sync.repository.js';
import {
  SYNC_MUTATIONS_RETENTION_MS,
  SyncMutationRetentionService
} from './sync-mutation-retention.service.js';

/**
 * L-09: sync.mutations retention. The sweeper prunes ledger rows older than
 * the retention window (default 90 days) in capped, idempotent batches.
 */

function record(id: string, createdAt: string) {
  return {
    userId: 'u',
    clientMutationId: id,
    entity: 'e',
    entityId: 'id',
    op: 'upsert' as const,
    status: 'applied' as const,
    newVersion: 1,
    detail: null,
    createdAt
  };
}

const NOW = new Date('2026-09-01T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - SYNC_MUTATIONS_RETENTION_MS - 86_400_000).toISOString();
const FRESH = new Date(NOW.getTime() - 86_400_000).toISOString();

describe('SyncMutationRetentionService', () => {
  it('prunes rows older than the retention window and keeps fresh ones', async () => {
    const mutations = new InMemorySyncMutationRepository();
    await mutations.record(record('stale', OLD));
    await mutations.record(record('fresh', FRESH));

    const sweeper = new SyncMutationRetentionService(mutations, {});
    const pruned = await sweeper.sweep(NOW);

    expect(pruned).toBe(1);
    expect(await mutations.find('u', 'stale')).toBeUndefined();
    expect(await mutations.find('u', 'fresh')).toBeDefined();
    // Idempotent: a second pass is a no-op.
    expect(await sweeper.sweep(NOW)).toBe(0);
  });

  it('honours SYNC_MUTATIONS_RETENTION_MS / batch cap from the environment', async () => {
    const mutations = new InMemorySyncMutationRepository();
    await mutations.record(record('a', '2026-08-20T00:00:00.000Z'));
    await mutations.record(record('b', '2026-08-25T00:00:00.000Z'));
    const sweeper = new SyncMutationRetentionService(mutations, {
      SYNC_MUTATIONS_RETENTION_MS: String(2 * 86_400_000), // 2 days
      SYNC_MUTATIONS_SWEEP_BATCH_SIZE: '1'
    });
    // Both rows are stale under a 2-day window; the cap drains one per pass.
    expect(await sweeper.sweep(NOW)).toBe(1);
    expect(await sweeper.sweep(NOW)).toBe(1);
    expect(await sweeper.sweep(NOW)).toBe(0);
  });

  it('does not arm a timer unless SWEEPERS_ENABLED=true', () => {
    const off = new SyncMutationRetentionService(new InMemorySyncMutationRepository(), {});
    off.onModuleInit();
    off.onModuleDestroy(); // no timer — must not throw or leak
    const on = new SyncMutationRetentionService(new InMemorySyncMutationRepository(), {
      SWEEPERS_ENABLED: 'true'
    });
    on.onModuleInit();
    on.onModuleDestroy();
  });
});
