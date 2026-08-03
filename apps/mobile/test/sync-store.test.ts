import { describe, expect, it, vi } from 'vitest';
import { createInMemoryStorage } from '../src/offline/queue';
import {
  createSyncStore,
  MAX_PAYLOAD_BYTES,
  PUSH_BATCH_SIZE,
  type SyncPullPage,
  type SyncPushRequestItem,
  type SyncPushResultItem,
  type SyncTransport
} from '../src/sync/store';

/* ------------------------------ helpers --------------------------------- */

function page(entity: string, items: SyncPullPage['items'], cursor: number, hasMore = false): SyncPullPage {
  return { entity, items, cursor, hasMore };
}

function pullTransport(pages: SyncPullPage[]): SyncTransport & { calls: Array<{ entity: string; since: number; limit: number }> } {
  const calls: Array<{ entity: string; since: number; limit: number }> = [];
  let index = 0;
  return {
    calls,
    pull: async (params) => {
      calls.push(params);
      const next = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return next;
    },
    push: async () => ({ results: [] }),
    status: async () => []
  };
}

function makeStore(transport: SyncTransport, storage = createInMemoryStorage()) {
  let seq = 0;
  return createSyncStore({
    storage,
    transport,
    now: () => new Date('2026-08-01T00:00:00.000Z'),
    mutationId: () => `mut-${(seq += 1)}`
  });
}

/* -------------------------------- pull ---------------------------------- */

describe('sync store — pull', () => {
  it('applies records and advances the cursor', async () => {
    const transport = pullTransport([
      page('notification', [
        { entityId: 'n-1', version: 3, deleted: false, payload: { title: 'Rain' } },
        { entityId: 'n-2', version: 5, deleted: false, payload: { title: 'Recall' } }
      ], 5)
    ]);
    const store = makeStore(transport);
    const summary = await store.pullEntity('notification');

    expect(summary).toEqual({ entity: 'notification', pages: 1, applied: 2, cursor: 5 });
    expect(store.getCursor('notification')).toBe(5);
    const records = store.getRecords('notification');
    expect(records.map((record) => record.entityId)).toEqual(['n-2', 'n-1']); // newest first
    expect(records[1].payload).toEqual({ title: 'Rain' });
    expect(records.every((record) => !record.pending)).toBe(true);
  });

  it('pages until hasMore is false, passing the cursor back as since', async () => {
    const transport = pullTransport([
      page('notification', [{ entityId: 'n-1', version: 2, deleted: false, payload: {} }], 2, true),
      page('notification', [{ entityId: 'n-2', version: 4, deleted: false, payload: {} }], 4)
    ]);
    const store = makeStore(transport);
    const summary = await store.pullEntity('notification');

    expect(summary.pages).toBe(2);
    expect(transport.calls.map((call) => call.since)).toEqual([0, 2]);
    expect(store.getCursor('notification')).toBe(4);
    expect(store.getRecords('notification')).toHaveLength(2);
  });

  it('applies tombstones: payload purged from reads, version kept', async () => {
    const transport = pullTransport([
      page('notification', [
        { entityId: 'n-1', version: 1, deleted: false, payload: { title: 'Old' } },
        { entityId: 'n-1', version: 2, deleted: true, payload: null }
      ], 2)
    ]);
    const store = makeStore(transport);
    await store.pullEntity('notification');

    expect(store.getRecords('notification')).toHaveLength(0);
    // Version kept for baseVersion bookkeeping: a later mutation bases on 2.
    await store.enqueue({ entity: 'notification', entityId: 'n-1', op: 'upsert', payload: { title: 'x' } });
    expect(store.getOutbox()[0].baseVersion).toBe(2);
  });

  it('never regresses the cursor on an empty page with a lower cursor', async () => {
    const transport = pullTransport([
      page('notification', [{ entityId: 'n-1', version: 7, deleted: false, payload: {} }], 7),
      page('notification', [], 3)
    ]);
    const store = makeStore(transport);
    await store.pullEntity('notification');
    await store.pullEntity('notification');
    expect(store.getCursor('notification')).toBe(7);
  });

  it('fails loudly on an empty page that claims hasMore (protocol violation)', async () => {
    const transport = pullTransport([page('notification', [], 0, true)]);
    const store = makeStore(transport);
    await expect(store.pullEntity('notification')).rejects.toThrow(/protocol violation/);
  });

  it('keeps the cache intact when the pull transport fails (no data loss)', async () => {
    const storage = createInMemoryStorage();
    const good = pullTransport([
      page('notification', [{ entityId: 'n-1', version: 4, deleted: false, payload: { title: 'Kept' } }], 4)
    ]);
    const store = makeStore(good, storage);
    await store.pullEntity('notification');

    const failing: SyncTransport = {
      pull: async () => {
        throw new Error('offline');
      },
      push: async () => ({ results: [] }),
      status: async () => []
    };
    const offlineStore = makeStore(failing, storage);
    await expect(offlineStore.pullEntity('notification')).rejects.toThrow('offline');
    expect(offlineStore.getRecords('notification')).toHaveLength(1);
    expect(offlineStore.getCursor('notification')).toBe(4);
  });

  it('resumes incrementally after a restart (cursor + records persisted)', async () => {
    const storage = createInMemoryStorage();
    const first = makeStore(
      pullTransport([page('notification', [{ entityId: 'n-1', version: 6, deleted: false, payload: { title: 'A' } }], 6)]),
      storage
    );
    await first.pullEntity('notification');

    const transport = pullTransport([page('notification', [], 6)]);
    const reopened = makeStore(transport, storage);
    await reopened.pullEntity('notification');
    expect(transport.calls[0].since).toBe(6); // incremental, not a full re-sync
    expect(reopened.getRecords('notification')).toHaveLength(1);
  });
});

/* ------------------------------- outbox --------------------------------- */

describe('sync store — outbox', () => {
  it('dedupes enqueue by clientMutationId', async () => {
    const store = makeStore(pullTransport([]));
    const input = { entity: 'farm', entityId: 'f-1', op: 'upsert' as const, payload: { name: 'A' }, clientMutationId: 'device-1-0001' };
    const first = await store.enqueue(input);
    const second = await store.enqueue({ ...input, payload: { name: 'B' } });
    expect(second).toBe(first);
    expect(store.getOutbox()).toHaveLength(1);
    expect(store.getOutbox()[0].payload).toEqual({ name: 'A' });
  });

  it('rejects payloads over the 64 KiB per-item limit', async () => {
    const store = makeStore(pullTransport([]));
    const big = { data: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    await expect(
      store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: big })
    ).rejects.toThrow(/64 KiB/);
    expect(store.getOutbox()).toHaveLength(0);
  });

  it('shows pending mutations optimistically in reads', async () => {
    const store = makeStore(pullTransport([]));
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'New farm' } });
    const records = store.getRecords('farm');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ entityId: 'f-1', version: 0, pending: true, payload: { name: 'New farm' } });
  });

  it('hides a record with a pending delete and overlays a pending upsert', async () => {
    const transport = pullTransport([
      page('farm', [
        { entityId: 'f-1', version: 2, deleted: false, payload: { name: 'Server A' } },
        { entityId: 'f-2', version: 3, deleted: false, payload: { name: 'Server B' } }
      ], 3)
    ]);
    const store = makeStore(transport);
    await store.pullEntity('farm');
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'Local edit' } });
    await store.enqueue({ entity: 'farm', entityId: 'f-2', op: 'delete' });

    const records = store.getRecords('farm');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ entityId: 'f-1', payload: { name: 'Local edit' }, pending: true, version: 2 });
  });
});

/* -------------------------------- push ---------------------------------- */

describe('sync store — push', () => {
  function appliedResults(items: SyncPushRequestItem[]): SyncPushResultItem[] {
    return items.map((item, index) => ({
      entity: item.entity,
      entityId: item.entityId,
      clientMutationId: item.clientMutationId,
      status: 'applied',
      newVersion: item.baseVersion + 1 + index * 0
    }));
  }

  it('sends the outbox in batches of at most 200 items', async () => {
    const batches: number[] = [];
    const transport: SyncTransport = {
      pull: async () => page('farm', [], 0),
      push: async (items) => {
        batches.push(items.length);
        return { results: appliedResults(items) };
      },
      status: async () => []
    };
    const store = makeStore(transport);
    for (let i = 0; i < PUSH_BATCH_SIZE + 5; i += 1) {
      await store.enqueue({ entity: 'farm', entityId: `f-${i}`, op: 'upsert', payload: { i } });
    }
    const summary = await store.pushPending();

    expect(batches).toEqual([200, 5]);
    expect(summary).toMatchObject({ batches: 2, applied: 205, remaining: 0 });
    expect(store.getOutbox()).toHaveLength(0);
  });

  it('confirms applied mutations with their new server version', async () => {
    const pushed: SyncPushRequestItem[][] = [];
    const transport: SyncTransport = {
      pull: async () => page('farm', [], 0),
      push: async (items) => {
        pushed.push(items);
        return { results: appliedResults(items) };
      },
      status: async () => []
    };
    const store = makeStore(transport);
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'A' }, clientMutationId: 'm-1' });
    const summary = await store.pushPending();

    expect(summary.applied).toBe(1);
    expect(pushed[0][0]).toMatchObject({ entity: 'farm', entityId: 'f-1', clientMutationId: 'm-1', baseVersion: 0, op: 'upsert' });
    expect(store.getRecords('farm')[0]).toMatchObject({ entityId: 'f-1', version: 1, pending: false });
  });

  it('retries a failed batch with the SAME clientMutationId (idempotent replay)', async () => {
    const seen: string[][] = [];
    let attempts = 0;
    const transport: SyncTransport = {
      pull: async () => page('farm', [], 0),
      push: async (items) => {
        attempts += 1;
        seen.push(items.map((item) => item.clientMutationId));
        if (attempts === 1) throw new Error('timeout');
        // Server replays the ORIGINAL recorded outcome for the seen ids.
        return { results: appliedResults(items) };
      },
      status: async () => []
    };
    const store = makeStore(transport);
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'A' }, clientMutationId: 'm-stable' });

    const first = await store.pushPending();
    expect(first.transportError).toBe('timeout');
    expect(store.getOutbox()).toHaveLength(1); // nothing lost

    const second = await store.pushPending();
    expect(second.applied).toBe(1);
    expect(seen).toEqual([['m-stable'], ['m-stable']]);
    expect(store.getOutbox()).toHaveLength(0);
    expect(store.getRecords('farm')).toHaveLength(1); // applied exactly once
  });

  it('resolves conflicts server-wins: adopts serverVersion + serverPayload, logs it', async () => {
    const transport: SyncTransport = {
      pull: async () => page('farm', [], 0),
      push: async (items) => ({
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'conflict' as const,
          serverVersion: 9,
          serverPayload: { name: 'Server truth' }
        }))
      }),
      status: async () => []
    };
    const store = makeStore(transport);
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'Local' }, clientMutationId: 'm-1' });
    const summary = await store.pushPending();

    expect(summary.conflicts).toBe(1);
    expect(store.getOutbox()).toHaveLength(0);
    const records = store.getRecords('farm');
    expect(records[0]).toMatchObject({ version: 9, payload: { name: 'Server truth' }, pending: false });
    expect(store.getConflictLog()).toEqual([
      {
        entity: 'farm',
        entityId: 'f-1',
        clientMutationId: 'm-1',
        serverVersion: 9,
        resolution: 'server-wins',
        resolvedAt: '2026-08-01T00:00:00.000Z'
      }
    ]);
    expect(store.getStatus().conflictsResolved).toBe(1);
  });

  it('drops permanent errors but keeps transient ones for the next attempt', async () => {
    const transport: SyncTransport = {
      pull: async () => page('farm', [], 0),
      push: async (items) => ({
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'error' as const,
          error: item.entityId === 'f-bad' ? 'forbidden' : 'apply_failed'
        }))
      }),
      status: async () => []
    };
    const store = makeStore(transport);
    await store.enqueue({ entity: 'farm', entityId: 'f-bad', op: 'upsert', payload: {} });
    await store.enqueue({ entity: 'farm', entityId: 'f-flaky', op: 'upsert', payload: {} });
    const summary = await store.pushPending();

    expect(summary).toMatchObject({ dropped: 1, retried: 1, remaining: 1 });
    expect(store.getOutbox().map((entry) => entry.entityId)).toEqual(['f-flaky']);
  });
});

/* ------------------------------- syncNow -------------------------------- */

describe('sync store — syncNow', () => {
  it('pulls every entity, flushes the outbox and stamps lastSyncAt', async () => {
    const transport: SyncTransport = {
      pull: async ({ entity }) => page(entity, [{ entityId: 'x-1', version: 1, deleted: false, payload: {} }], 1),
      push: async (items) => ({
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'applied' as const,
          newVersion: 1
        }))
      }),
      status: async () => []
    };
    const store = makeStore(transport);
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'A' } });
    const summary = await store.syncNow(['notification', 'marketplace_listing']);

    expect(summary.errors).toEqual([]);
    expect(summary.pulled).toHaveLength(2);
    expect(summary.pushed?.applied).toBe(1);
    const status = store.getStatus();
    expect(status.lastSyncAt).toBe('2026-08-01T00:00:00.000Z');
    expect(status.lastError).toBeNull();
    expect(status.pending).toBe(0);
    expect(status.cursors).toEqual({ notification: 1, marketplace_listing: 1 });
  });

  it('records per-entity pull failures without losing cached data or pending mutations', async () => {
    const storage = createInMemoryStorage();
    const seeding = makeStore(
      pullTransport([page('notification', [{ entityId: 'n-1', version: 2, deleted: false, payload: { title: 'Saved' } }], 2)]),
      storage
    );
    await seeding.pullEntity('notification');
    await seeding.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'Queued' } });

    const failing: SyncTransport = {
      pull: async () => {
        throw new Error('network down');
      },
      push: async () => {
        throw new Error('network down');
      },
      status: async () => []
    };
    const store = makeStore(failing, storage);
    const summary = await store.syncNow(['notification']);

    expect(summary.errors).toHaveLength(2); // pull + push
    expect(store.getStatus().lastError).toBe('network down');
    expect(store.getStatus().lastSyncAt).toBeNull();
    expect(store.getRecords('notification')).toHaveLength(1); // cache intact
    expect(store.getStatus().pending).toBe(1); // outbox intact
  });

  it('notifies subscribers on status changes', async () => {
    const store = makeStore(pullTransport([page('notification', [], 0)]));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: {} });
    expect(listener).toHaveBeenCalled();
    expect(store.getStatus().pending).toBe(1);
    unsubscribe();
  });
});
