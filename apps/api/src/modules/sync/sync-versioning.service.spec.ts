import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import {
  createInMemoryEntityVersionRepository,
  createInMemorySyncVersionBumpRetryRepository,
  type EntityVersionRepository
} from '../../database/repositories/sync.repository.js';
import {
  SYNC_VERSION_RETRY_MAX_ATTEMPTS,
  SyncVersioningService
} from './sync-versioning.service.js';

/**
 * L-10: a failed version bump after a REST write is sync-invisible — it must
 * never be silent. The hook stays non-throwing (the entity write already
 * landed), but it increments `agric_sync_version_bump_failures_total` and
 * logs a WARN.
 */
describe('SyncVersioningService failure visibility', () => {
  it('increments the failure counter (and does not throw) when the bump fails', async () => {
    const failing: EntityVersionRepository = {
      bump: vi.fn().mockRejectedValue(new Error('db blip')),
      applyGuarded: vi.fn(),
      current: vi.fn(),
      listSince: vi.fn(),
      maxChangeSeq: vi.fn()
    };
    const metrics = new MetricsService();
    const inc = vi.spyOn(metrics, 'recordSyncVersionBumpFailure');
    const service = new SyncVersioningService(failing, metrics);

    await expect(
      service.recordChange({ entity: 'farm_plot', entityId: 'p-1', ownerId: 'u', actorId: 'u' })
    ).resolves.toBeUndefined();
    expect(inc).toHaveBeenCalledWith('farm_plot');
  });

  it('does not count a successful bump', async () => {
    const versions = createInMemoryEntityVersionRepository();
    const metrics = new MetricsService();
    const inc = vi.spyOn(metrics, 'recordSyncVersionBumpFailure');
    const service = new SyncVersioningService(versions, metrics);

    await service.recordChange({ entity: 'farm_plot', entityId: 'p-1', ownerId: 'u', actorId: 'u' });
    expect(inc).not.toHaveBeenCalled();
    expect((await versions.current('farm_plot', 'p-1'))!.version).toBe(1);
  });
});

/**
 * GAP-M11: a failed bump is enqueued as a compensating retry and the
 * reconciliation pass re-applies it — the write becomes sync-visible again
 * instead of waiting for the next write.
 */
describe('SyncVersioningService bump reconciliation (GAP-M11)', () => {
  const change = { entity: 'farm_plot', entityId: 'p-1', ownerId: 'u', actorId: 'u' };

  it('enqueues a compensating retry when the bump fails (and still never throws)', async () => {
    const failing: EntityVersionRepository = {
      bump: vi.fn().mockRejectedValue(new Error('db blip')),
      applyGuarded: vi.fn(),
      current: vi.fn(),
      listSince: vi.fn(),
      maxChangeSeq: vi.fn()
    };
    const retries = createInMemorySyncVersionBumpRetryRepository();
    const service = new SyncVersioningService(failing, undefined, retries);

    await expect(service.recordChange(change)).resolves.toBeUndefined();
    const pending = await retries.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      entity: 'farm_plot',
      entityId: 'p-1',
      ownerId: 'u',
      actorId: 'u',
      deleted: false,
      attempts: 0,
      lastError: 'db blip'
    });
  });

  it('reconcile re-applies the queued bump and removes the row (write sync-visible again)', async () => {
    const versions = createInMemoryEntityVersionRepository();
    const retries = createInMemorySyncVersionBumpRetryRepository();
    await retries.enqueue({ ...change, deleted: false }, 'db blip');
    const service = new SyncVersioningService(versions, undefined, retries);

    const result = await service.reconcileFailedBumps();
    expect(result).toEqual({ retried: 1, recovered: 1, failed: 0, exhausted: 0 });
    expect(await retries.listPending(10)).toHaveLength(0);
    // The compensating bump landed: the record is visible to /sync/pull.
    const row = await versions.current('farm_plot', 'p-1');
    expect(row).toMatchObject({ version: 1, ownerId: 'u', deleted: false });
  });

  it('a failed re-bump counts the attempt and keeps the row for the next pass', async () => {
    let calls = 0;
    const flaky: EntityVersionRepository = {
      bump: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error('still down'));
        }
        return Promise.resolve(1);
      }),
      applyGuarded: vi.fn(),
      current: vi.fn(),
      listSince: vi.fn(),
      maxChangeSeq: vi.fn()
    };
    const retries = createInMemorySyncVersionBumpRetryRepository();
    await retries.enqueue({ ...change, deleted: false }, 'db blip');
    const service = new SyncVersioningService(flaky, undefined, retries);

    const first = await service.reconcileFailedBumps();
    expect(first).toEqual({ retried: 1, recovered: 0, failed: 1, exhausted: 0 });
    const [row] = await retries.listPending(10);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('still down');

    // Next pass recovers.
    const second = await service.reconcileFailedBumps();
    expect(second).toEqual({ retried: 1, recovered: 1, failed: 0, exhausted: 0 });
    expect(await retries.listPending(10)).toHaveLength(0);
  });

  it('rows at the attempt budget are skipped and reported, never silently dropped', async () => {
    const versions = createInMemoryEntityVersionRepository();
    const retries = createInMemorySyncVersionBumpRetryRepository();
    await retries.enqueue({ ...change, deleted: false }, 'db blip');
    for (let i = 0; i < SYNC_VERSION_RETRY_MAX_ATTEMPTS; i += 1) {
      await retries.recordAttempt(change.entity, change.entityId, 'still down');
    }
    const service = new SyncVersioningService(versions, undefined, retries);

    const result = await service.reconcileFailedBumps();
    expect(result).toEqual({ retried: 0, recovered: 0, failed: 0, exhausted: 1 });
    // Kept for ops inspection — no bump attempted, row still queued.
    expect(await retries.listPending(10)).toHaveLength(1);
    expect(await versions.current('farm_plot', 'p-1')).toBeUndefined();
  });

  it('repeated recordChange failures upsert one row with a fresh attempt budget', async () => {
    const failing: EntityVersionRepository = {
      bump: vi.fn().mockRejectedValue(new Error('db blip')),
      applyGuarded: vi.fn(),
      current: vi.fn(),
      listSince: vi.fn(),
      maxChangeSeq: vi.fn()
    };
    const retries = createInMemorySyncVersionBumpRetryRepository();
    const service = new SyncVersioningService(failing, undefined, retries);

    await service.recordChange(change);
    await retries.recordAttempt(change.entity, change.entityId, 'x');
    await service.recordChange({ ...change, deleted: true });

    const pending = await retries.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ attempts: 0, deleted: true });
  });

  it('without a retry repository the failure path still never throws', async () => {
    const failing: EntityVersionRepository = {
      bump: vi.fn().mockRejectedValue(new Error('db blip')),
      applyGuarded: vi.fn(),
      current: vi.fn(),
      listSince: vi.fn(),
      maxChangeSeq: vi.fn()
    };
    const service = new SyncVersioningService(failing);
    await expect(service.recordChange(change)).resolves.toBeUndefined();
    await expect(service.reconcileFailedBumps()).resolves.toEqual({
      retried: 0,
      recovered: 0,
      failed: 0,
      exhausted: 0
    });
  });
});
