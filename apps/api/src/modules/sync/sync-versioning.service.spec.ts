import { describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import {
  createInMemoryEntityVersionRepository,
  type EntityVersionRepository
} from '../../database/repositories/sync.repository.js';
import { SyncVersioningService } from './sync-versioning.service.js';

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
      bumpExpected: vi.fn(),
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
