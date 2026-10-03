import { describe, expect, it } from 'vitest';
import {
  createInMemoryEntityVersionRepository,
  createInMemorySyncVersionBumpRetryRepository
} from '../../database/repositories/sync.repository.js';
import { SyncVersioningService, SYNC_VERSION_RETRY_MAX_ATTEMPTS } from './sync-versioning.service.js';

const CHANGE = {
  entity: 'marketplace_listing',
  entityId: 'listing-1',
  ownerId: 'seller-1',
  actorId: 'seller-1',
  deleted: false
};

function build(options: { failBumps?: number } = {}) {
  const versions = createInMemoryEntityVersionRepository();
  const retries = createInMemorySyncVersionBumpRetryRepository();
  let failuresLeft = options.failBumps ?? 0;
  const failingVersions = {
    ...versions,
    bump: async (input: Parameters<typeof versions.bump>[0]) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('version ledger down');
      }
      return versions.bump(input);
    }
  };
  const service = new SyncVersioningService(failingVersions, undefined, retries);
  return { service, versions, retries };
}

describe('SyncVersioningService failed-bump reconciliation (GAP-M11)', () => {
  it('a failed bump enqueues a compensating retry entry (never throws)', async () => {
    const { service, retries } = build({ failBumps: 1 });
    await expect(service.recordChange(CHANGE)).resolves.toBeUndefined();
    const pending = await retries.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      entity: CHANGE.entity,
      entityId: CHANGE.entityId,
      ownerId: CHANGE.ownerId,
      attempts: 0,
      lastError: 'version ledger down'
    });
  });

  it('the reconciliation pass re-applies the bump and removes the entry', async () => {
    const { service, versions, retries } = build({ failBumps: 1 });
    await service.recordChange(CHANGE);
    const result = await service.reconcileFailedBumps();
    expect(result).toEqual({ retried: 1, recovered: 1, failed: 0, exhausted: 0 });
    expect(await retries.listPending(10)).toHaveLength(0);
    // The write is sync-visible again: the version advanced.
    const row = await versions.get(CHANGE.entity, CHANGE.entityId);
    expect(row?.version).toBe(1);
  });

  it('a bump that keeps failing stays queued with an incremented attempt budget', async () => {
    const { service, retries } = build({ failBumps: Number.MAX_SAFE_INTEGER });
    await service.recordChange(CHANGE);
    const result = await service.reconcileFailedBumps();
    expect(result).toEqual({ retried: 1, recovered: 0, failed: 1, exhausted: 0 });
    const pending = await retries.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
  });

  it('exhausted rows are KEPT for ops and surfaced, never silently dropped', async () => {
    const { service, retries } = build({ failBumps: Number.MAX_SAFE_INTEGER });
    await service.recordChange(CHANGE);
    for (let pass = 0; pass < SYNC_VERSION_RETRY_MAX_ATTEMPTS; pass += 1) {
      await service.reconcileFailedBumps();
    }
    const result = await service.reconcileFailedBumps();
    expect(result.retried).toBe(0);
    expect(result.exhausted).toBe(1);
    const pending = await retries.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(SYNC_VERSION_RETRY_MAX_ATTEMPTS);
  });

  it('a successful bump leaves no retry entry', async () => {
    const { service, retries } = build();
    await service.recordChange(CHANGE);
    expect(await retries.listPending(10)).toHaveLength(0);
  });
});
