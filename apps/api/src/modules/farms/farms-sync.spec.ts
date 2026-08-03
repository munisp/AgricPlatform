import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCropPlantingRepository,
  createInMemoryFarmExpenseRepository,
  createInMemoryFarmPlotRepository,
  createInMemoryHarvestRecordRepository
} from '../../database/repositories/farms.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  InMemoryEntityVersionRepository,
  InMemorySyncCursorRepository,
  InMemorySyncMutationRepository
} from '../../database/repositories/sync.repository.js';
import { SyncEntityRegistry } from '../sync/sync-registry.js';
import { SyncVersioningService } from '../sync/sync-versioning.service.js';
import { SyncService } from '../sync/sync.service.js';
import type { SyncPushItem } from '../sync/sync.types.js';
import { SYNC_ENTITY_FARM_PLOT } from './farms.service.js';
import { FarmsService } from './farms.service.js';
import { FarmsSyncEntities } from './farms-sync.js';

/**
 * W-SYNCWRITE parity suite: `farm_plot` is the first WRITABLE sync entity.
 * Exercises the full protocol loop over the in-memory ports — push apply
 * (create/update/delete), baseVersion CAS conflicts, clientMutationId
 * idempotent replay, owner scoping, batch independence, and pull pages with
 * monotonic cursors + tombstones — plus REST-write sync visibility via the
 * SyncVersioningService hook.
 */

const farmer = { id: 'farmer-1', roles: ['farmer'] } as User;
const outsider = { id: 'farmer-2', roles: ['farmer'] } as User;
const admin = { id: 'admin-1', roles: ['admin'] } as User;

function plotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Zaria North Plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.0855,
    centroidLong: 7.7199,
    sizeHectares: 2.5,
    soilType: 'loamy',
    ...overrides
  };
}

function pushItem(
  partial: Partial<SyncPushItem> & Pick<SyncPushItem, 'entityId' | 'clientMutationId'>
): SyncPushItem {
  return {
    entity: SYNC_ENTITY_FARM_PLOT,
    baseVersion: 0,
    op: 'upsert',
    payload: plotPayload(),
    ...partial
  };
}

function makeHarness() {
  const versions = new InMemoryEntityVersionRepository();
  const cursors = new InMemorySyncCursorRepository();
  const mutations = new InMemorySyncMutationRepository();
  const registry = new SyncEntityRegistry();
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const events = new DomainEventsService(createInMemoryOutboxRepository());

  const plots = createInMemoryFarmPlotRepository();
  const farms = new FarmsService(
    audit,
    events,
    plots,
    createInMemoryCropPlantingRepository(),
    createInMemoryHarvestRecordRepository(),
    createInMemoryFarmExpenseRepository(),
    new SyncVersioningService(versions),
    versions
  );
  new FarmsSyncEntities(registry, farms, plots).onModuleInit();

  const sync = new SyncService(registry, versions, cursors, mutations, events, audit);
  return { sync, farms, plots, versions, cursors, mutations, registry, events };
}

describe('farm_plot sync registration', () => {
  it('registers farm_plot as a writable entity', () => {
    const h = makeHarness();
    const descriptor = h.registry.get(SYNC_ENTITY_FARM_PLOT);
    expect(descriptor).toMatchObject({
      name: 'farm_plot',
      ownerField: 'ownerUserId',
      writable: true
    });
    expect(descriptor?.apply).toBeTypeOf('function');
  });
});

describe('farm_plot sync push — apply', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('applies a create at baseVersion 0 under the client-stable entity id', async () => {
    const [result] = await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 1 });

    const plot = await h.plots.findById('plot-a');
    expect(plot).toMatchObject({
      id: 'plot-a',
      ownerUserId: farmer.id,
      name: 'Zaria North Plot',
      state: 'Kaduna',
      version: 1,
      // The mutation id doubles as the offline-merge client id on creates.
      clientId: 'm-1'
    });
    const row = await h.versions.current(SYNC_ENTITY_FARM_PLOT, 'plot-a');
    expect(row).toMatchObject({ version: 1, ownerId: farmer.id, deleted: false });
  });

  it('applies an update at the matching baseVersion (full replacement)', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(farmer, [
      pushItem({
        entityId: 'plot-a',
        clientMutationId: 'm-2',
        baseVersion: 1,
        payload: plotPayload({ name: 'Zaria North (extended)', sizeHectares: 3 })
      })
    ]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 2 });
    const plot = await h.plots.findById('plot-a');
    expect(plot).toMatchObject({ name: 'Zaria North (extended)', sizeHectares: 3, version: 2 });
  });

  it('conflicts on a stale baseVersion and never overwrites server state', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(farmer, [
      pushItem({
        entityId: 'plot-a',
        clientMutationId: 'm-2',
        baseVersion: 0,
        payload: plotPayload({ name: 'stale overwrite attempt' })
      })
    ]);
    expect(result.status).toBe('conflict');
    expect(result.serverVersion).toBe(1);
    expect(result.serverPayload).toMatchObject({ name: 'Zaria North Plot' });
    expect((await h.plots.findById('plot-a'))!.name).toBe('Zaria North Plot');
  });

  it('conflicts when updating a missing record with baseVersion > 0', async () => {
    const [result] = await h.sync.push(farmer, [
      pushItem({ entityId: 'ghost', clientMutationId: 'm-1', baseVersion: 4 })
    ]);
    expect(result).toMatchObject({ status: 'conflict', serverVersion: 0, serverPayload: null });
  });

  it('replays the ORIGINAL outcome for a retried clientMutationId (applied once)', async () => {
    const first = await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const replay = await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    expect(replay[0]).toEqual(first[0]);
    expect((await h.versions.current(SYNC_ENTITY_FARM_PLOT, 'plot-a'))!.version).toBe(1);
    expect(await h.plots.all()).toHaveLength(1);
  });

  it('rejects reuse of a clientMutationId for a different mutation', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(farmer, [pushItem({ entityId: 'plot-b', clientMutationId: 'm-1' })]);
    expect(result).toMatchObject({ status: 'error', error: 'mutation_id_reused' });
    expect(await h.plots.findById('plot-b')).toBeUndefined();
  });

  it('rejects a non-owner update with per-item forbidden', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(outsider, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-9', baseVersion: 1 })
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'forbidden' });
    expect((await h.plots.findById('plot-a'))!.name).toBe('Zaria North Plot');
  });

  it('lets an admin mutate another farmer\'s plot (protocol §3)', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(admin, [
      pushItem({
        entityId: 'plot-a',
        clientMutationId: 'm-2',
        baseVersion: 1,
        payload: plotPayload({ name: 'Admin correction' })
      })
    ]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 2 });
    // The sync scope stays with the original owner.
    expect((await h.versions.current(SYNC_ENTITY_FARM_PLOT, 'plot-a'))!.ownerId).toBe(farmer.id);
  });

  it('fails closed on an invalid payload (apply_failed, nothing persisted, not ledgered)', async () => {
    const [result] = await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-1', payload: plotPayload({ state: 'Atlantis' }) })
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'apply_failed' });
    expect(await h.plots.findById('plot-a')).toBeUndefined();
    expect(await h.mutations.find(farmer.id, 'm-1')).toBeUndefined();
    // A corrected retry under the same mutation id can still succeed.
    const [retry] = await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    expect(retry).toMatchObject({ status: 'applied', newVersion: 1 });
  });

  it('keeps batch items independent: a conflict never blocks a sibling', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const results = await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-2', baseVersion: 0 }), // stale → conflict
      pushItem({ entityId: 'plot-b', clientMutationId: 'm-3' }) // fresh → applied
    ]);
    expect(results[0]).toMatchObject({ status: 'conflict', serverVersion: 1 });
    expect(results[1]).toMatchObject({ status: 'applied', newVersion: 1 });
    expect(await h.plots.findById('plot-b')).toBeDefined();
  });

  it('audits and emits sync.mutation.applied per applied item', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const outbox = await h.events.listOutbox();
    expect(outbox.map((event) => event.name)).toContain('sync.mutation.applied');
  });
});

describe('farm_plot sync push — deletes', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('applies a delete at the matching baseVersion and serves a tombstone', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-2', baseVersion: 1, op: 'delete', payload: undefined })
    ]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 2 });
    expect(await h.plots.findById('plot-a')).toBeUndefined();

    const page = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, 0);
    expect(page.items).toEqual([{ entityId: 'plot-a', version: 2, deleted: true, payload: null }]);
  });

  it('conflicts a delete based on a stale version', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-2', baseVersion: 1, payload: plotPayload({ name: 'v2' }) })
    ]);
    const [result] = await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-3', baseVersion: 1, op: 'delete', payload: undefined })
    ]);
    expect(result).toMatchObject({ status: 'conflict', serverVersion: 2 });
    expect(await h.plots.findById('plot-a')).toBeDefined();
  });

  it('rejects a non-owner delete', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const [result] = await h.sync.push(outsider, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-9', baseVersion: 1, op: 'delete', payload: undefined })
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'forbidden' });
    expect(await h.plots.findById('plot-a')).toBeDefined();
  });
});

describe('farm_plot sync pull', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('returns only the caller\'s plots, version-ordered, with a monotonic cursor', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-b', clientMutationId: 'm-2' })]);
    await h.sync.push(outsider, [pushItem({ entityId: 'plot-x', clientMutationId: 'm-1' })]);

    const page = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, 0);
    expect(page.items.map((item) => item.entityId)).toEqual(['plot-a', 'plot-b']);
    expect(page.cursor).toBe(1); // per-record versions: max in scope is 1
    expect(page.hasMore).toBe(false);

    // Empty follow-up page never regresses the cursor.
    const empty = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, page.cursor);
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBe(1);
  });

  it('pages with hasMore until the caller\'s scope is exhausted', async () => {
    // Versions are per-record (protocol §9): give each plot a distinct
    // version so the version-ordered pages partition cleanly.
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-b', clientMutationId: 'm-2' })]);
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-c', clientMutationId: 'm-3' })]);
    await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-b', clientMutationId: 'm-4', baseVersion: 1 })
    ]);
    await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-c', clientMutationId: 'm-5', baseVersion: 1 })
    ]);
    await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-c', clientMutationId: 'm-6', baseVersion: 2 })
    ]);

    const first = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, 0, 2);
    expect(first.items.map((item) => [item.entityId, item.version])).toEqual([
      ['plot-a', 1],
      ['plot-b', 2]
    ]);
    expect(first.hasMore).toBe(true);
    const second = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, first.cursor, 2);
    expect(second.items.map((item) => [item.entityId, item.version])).toEqual([['plot-c', 3]]);
    expect(second.hasMore).toBe(false);
  });

  it('makes REST writes sync-visible (create bumps, delete tombstones)', async () => {
    const created = await h.farms.createPlot(farmer, {
      name: 'REST plot',
      state: 'Kano',
      lga: 'Kura',
      centroidLat: 11.5,
      centroidLong: 8.5,
      sizeHectares: 1
    });
    let page = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, 0);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ entityId: created.id, version: 1, deleted: false });
    expect((page.items[0].payload as { name: string }).name).toBe('REST plot');

    await h.farms.removePlot(farmer, created.id);
    page = await h.sync.pull(farmer, SYNC_ENTITY_FARM_PLOT, page.cursor);
    expect(page.items).toEqual([{ entityId: created.id, version: 2, deleted: true, payload: null }]);
  });

  it('scopes tombstones to the owner (outsider never sees them)', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    await h.sync.push(farmer, [
      pushItem({ entityId: 'plot-a', clientMutationId: 'm-2', baseVersion: 1, op: 'delete', payload: undefined })
    ]);
    const page = await h.sync.pull(outsider, SYNC_ENTITY_FARM_PLOT, 0);
    expect(page.items).toEqual([]);
  });

  it('surfaces farm_plot in /sync/status with the scoped max version', async () => {
    await h.sync.push(farmer, [pushItem({ entityId: 'plot-a', clientMutationId: 'm-1' })]);
    const status = await h.sync.status(farmer);
    const entry = status.find((candidate) => candidate.entity === SYNC_ENTITY_FARM_PLOT);
    expect(entry).toMatchObject({ serverMaxVersion: 1, cursor: 0 });
  });
});
