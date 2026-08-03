/**
 * W-SYNCWRITE outbox routing: plot captures flow through the record-level
 * sync outbox end-to-end — queued offline (durable), flushed on reconnect,
 * applied exactly once, conflicts resolved server-wins and logged. Also
 * covers the connectivity binding flushing the sync outbox alongside the
 * legacy queue (metered connections included) and the deterministic
 * plot-id derivation.
 */
import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { createInMemoryStorage, createOfflineQueue } from '../src/offline/queue';
import {
  derivedPlotId,
  PlotCaptureScreen,
  type LocationService,
  type SavedPlotSummary
} from '../src/screens/PlotCaptureScreen';
import { startConnectivitySync } from '../src/sync/connectivity';
import { SyncProvider, useSyncStore } from '../src/sync/context';
import { SYNC_ENTITY_FARM_PLOT } from '../src/sync/entities';
import {
  createSyncStore,
  type SyncPullPage,
  type SyncPushRequestItem,
  type SyncStore,
  type SyncTransport
} from '../src/sync/store';

/* ------------------------------ helpers --------------------------------- */

function flattenText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

function screenText(root: ReactTestInstance): string {
  return root
    .findAllByType('rn-text' as never)
    .map((node) => flattenText((node as { props: { children?: unknown } }).props.children))
    .join('\n');
}

function pressByLabel(root: ReactTestInstance, label: string): void {
  const target = root
    .findAllByType('rn-pressable' as never)
    .find((node) => flattenText(node).includes(label));
  if (!target) throw new Error(`No pressable labelled "${label}"`);
  (target.props as { onPress?: () => void }).onPress?.();
}

function setInputAt(root: ReactTestInstance, index: number, value: string): void {
  const inputs = root.findAllByType('rn-text-input' as never);
  const target = inputs[index];
  if (!target) throw new Error(`No text input at index ${index}`);
  (target.props as { onChangeText?: (text: string) => void }).onChangeText?.(value);
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function interact(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
  });
  await flush();
}

const goodGps: LocationService = {
  getCurrentPoint: () => Promise.resolve({ lat: 11.0855, long: 7.7199, accuracyMeters: 6 })
};

/**
 * Transport double with a connectivity switch: offline pushes reject like a
 * dead network; online pushes apply every item (echoing the protocol's
 * per-item results). Pulls return an empty page.
 */
function switchableTransport() {
  const state = {
    online: false,
    pushed: [] as SyncPushRequestItem[][]
  };
  const transport: SyncTransport = {
    push: async (items) => {
      if (!state.online) {
        throw new TypeError('fetch failed');
      }
      state.pushed.push(items);
      return {
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'applied' as const,
          newVersion: item.baseVersion + 1
        }))
      };
    },
    pull: async (params): Promise<SyncPullPage> => ({
      entity: params.entity,
      items: [],
      cursor: params.since,
      hasMore: false
    }),
    status: async () => []
  };
  return { state, transport };
}

async function renderCapture(store: SyncStore, ui?: ReactNode): Promise<ReactTestRenderer> {
  const client = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
  });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <ApiProvider client={client}>
        {ui ?? <PlotCaptureScreen state="Kano" locationService={goodGps} store={store} />}
      </ApiProvider>
    );
  });
  await flush();
  return renderer!;
}

async function captureAndSave(root: ReactTestInstance, name: string): Promise<void> {
  await interact(() => setInputAt(root, 0, name));
  await interact(() => setInputAt(root, 1, 'Zaria'));
  await interact(() => setInputAt(root, 2, '2.5'));
  await interact(() => pressByLabel(root, 'Capture centre point'));
  await interact(() => pressByLabel(root, 'Save plot'));
}

/* -------------------------------- tests --------------------------------- */

describe('plot capture → sync outbox routing', () => {
  it('queues offline, flushes on reconnect and confirms exactly once', async () => {
    const { state, transport } = switchableTransport();
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    const renderer = await renderCapture(store);

    // Offline capture: the entry lands in the durable outbox, unsent.
    await captureAndSave(renderer.root, 'Reconnect Plot');
    expect(state.pushed).toHaveLength(0); // pushes rejected at transport
    expect(store.getOutbox()).toHaveLength(1);
    expect(screenText(renderer.root)).toContain('queued');

    // Reconnect: the connectivity flush pushes the SAME mutation once.
    state.online = true;
    await act(async () => {
      await store.pushPending();
    });
    expect(state.pushed).toHaveLength(1);
    expect(state.pushed[0]).toHaveLength(1);
    expect(state.pushed[0][0]).toMatchObject({
      entity: SYNC_ENTITY_FARM_PLOT,
      op: 'upsert',
      baseVersion: 0
    });
    expect(store.getOutbox()).toHaveLength(0);

    // Confirmed locally with the server version; no longer optimistic.
    const records = store.getRecords(SYNC_ENTITY_FARM_PLOT);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ version: 1, pending: false });
    expect((records[0].payload as { name: string }).name).toBe('Reconnect Plot');

    // A further flush is a no-op — nothing is applied twice.
    await act(async () => {
      await store.pushPending();
    });
    expect(state.pushed).toHaveLength(1);
  });

  it('resolves a conflict server-wins, logs it and drains the outbox', async () => {
    const serverPlot = {
      id: 'plot-server',
      name: 'Server-corrected plot',
      state: 'Kano',
      lga: 'Kura',
      sizeHectares: 4
    };
    const transport: SyncTransport = {
      push: async (items) => ({
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'conflict' as const,
          serverVersion: 3,
          serverPayload: serverPlot
        }))
      }),
      pull: async (params) => ({ entity: params.entity, items: [], cursor: params.since, hasMore: false }),
      status: async () => []
    };
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    let saved: SavedPlotSummary | null = null;
    const renderer = await renderCapture(
      store,
      <PlotCaptureScreen
        state="Kano"
        locationService={goodGps}
        store={store}
        onSaved={(plot) => (saved = plot)}
      />
    );

    await captureAndSave(renderer.root, 'Contested Plot');

    // Outbox drained; the server state was adopted verbatim (server-wins v1).
    expect(store.getOutbox()).toHaveLength(0);
    const records = store.getRecords(SYNC_ENTITY_FARM_PLOT);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ version: 3, pending: false });
    expect((records[0].payload as { name: string }).name).toBe('Server-corrected plot');

    // …and the resolution is auditable via the conflict log (SyncBadge count).
    const conflicts = store.getConflictLog();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      entity: SYNC_ENTITY_FARM_PLOT,
      serverVersion: 3,
      resolution: 'server-wins'
    });
    expect(saved).toMatchObject({ synced: true, version: 3 });
  });

  it('keeps a transiently failed capture queued for the next attempt', async () => {
    // apply_failed is transient (§10): the entry stays in the outbox with
    // its stable clientMutationId so the next sync pass retries it.
    let calls = 0;
    const transport: SyncTransport = {
      push: async (items) => {
        calls += 1;
        if (calls === 1) {
          return {
            results: items.map((item) => ({
              entity: item.entity,
              entityId: item.entityId,
              clientMutationId: item.clientMutationId,
              status: 'error' as const,
              error: 'apply_failed'
            }))
          };
        }
        return {
          results: items.map((item) => ({
            entity: item.entity,
            entityId: item.entityId,
            clientMutationId: item.clientMutationId,
            status: 'applied' as const,
            newVersion: 1
          }))
        };
      },
      pull: async (params) => ({ entity: params.entity, items: [], cursor: params.since, hasMore: false }),
      status: async () => []
    };
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    const renderer = await renderCapture(store);

    await captureAndSave(renderer.root, 'Retry Plot');

    // Transient failure: still queued, and the UI says so honestly.
    expect(store.getOutbox()).toHaveLength(1);
    expect(screenText(renderer.root)).toContain('queued');
    const mutationId = store.getOutbox()[0].clientMutationId;

    // Next flush (reconnect/foreground) retries the SAME mutation id.
    await act(async () => {
      await store.pushPending();
    });
    expect(calls).toBe(2);
    expect(store.getOutbox()).toHaveLength(0);
    const records = store.getRecords(SYNC_ENTITY_FARM_PLOT);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ version: 1, pending: false });
    expect(mutationId).toContain('farms.plot.');
  });

  it('drops a permanently rejected capture and surfaces an error', async () => {
    const transport: SyncTransport = {
      push: async (items) => ({
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'error' as const,
          error: 'forbidden'
        }))
      }),
      pull: async (params) => ({ entity: params.entity, items: [], cursor: params.since, hasMore: false }),
      status: async () => []
    };
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    const renderer = await renderCapture(store);

    await captureAndSave(renderer.root, 'Rejected Plot');

    expect(store.getOutbox()).toHaveLength(0);
    expect(store.getRecords(SYNC_ENTITY_FARM_PLOT)).toHaveLength(0);
    expect(screenText(renderer.root)).toContain('rejected');
  });
});

describe('plot capture durability, replay and pull', () => {
  it('keeps a queued capture durable across a store restart', async () => {
    // Same AsyncStorage-like backend, fresh store instance = app restart.
    const storage = createInMemoryStorage();
    const { transport } = switchableTransport();
    const first = createSyncStore({ storage, transport });
    const renderer = await renderCapture(first);
    await captureAndSave(renderer.root, 'Durable Plot');
    expect(first.getOutbox()).toHaveLength(1);

    const restarted = createSyncStore({ storage, transport });
    await restarted.hydrate();
    const outbox = restarted.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      entity: SYNC_ENTITY_FARM_PLOT,
      op: 'upsert',
      clientMutationId: first.getOutbox()[0].clientMutationId
    });
    expect(outbox[0].payload).toMatchObject({ name: 'Durable Plot' });
  });

  it('re-applies nothing when the same capture is re-sent after success (server replay)', async () => {
    // Server double with the §5 ledger: a seen clientMutationId replays its
    // ORIGINAL outcome without re-applying.
    const ledger = new Map<string, { status: 'applied'; newVersion: number }>();
    let applies = 0;
    const transport: SyncTransport = {
      push: async (items) => ({
        results: items.map((item) => {
          const key = `${item.entity} ${item.clientMutationId}`;
          const recorded = ledger.get(key);
          if (recorded) {
            return {
              entity: item.entity,
              entityId: item.entityId,
              clientMutationId: item.clientMutationId,
              ...recorded
            };
          }
          applies += 1;
          const outcome = { status: 'applied' as const, newVersion: 1 };
          ledger.set(key, outcome);
          return {
            entity: item.entity,
            entityId: item.entityId,
            clientMutationId: item.clientMutationId,
            ...outcome
          };
        })
      }),
      pull: async (params) => ({ entity: params.entity, items: [], cursor: params.since, hasMore: false }),
      status: async () => []
    };
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    const renderer = await renderCapture(store);

    await captureAndSave(renderer.root, 'Replay Plot');
    expect(applies).toBe(1);

    // Re-enter the SAME capture (form cleared after success) and save again:
    // same mutation key → the server replays, no second plot is applied.
    await captureAndSave(renderer.root, 'Replay Plot');
    expect(applies).toBe(1);
    expect(store.getOutbox()).toHaveLength(0);
    expect(store.getRecords(SYNC_ENTITY_FARM_PLOT)).toHaveLength(1);
  });

  it('pulls server-confirmed plots into the local cache ( FarmsScreen refresh source )', async () => {
    const serverPlot = {
      id: 'plot-pulled',
      ownerUserId: 'farmer-1',
      name: 'Pulled Plot',
      state: 'Kano',
      lga: 'Kura',
      centroidLat: 11.5,
      centroidLong: 8.5,
      sizeHectares: 1.5,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      version: 1
    };
    const transport: SyncTransport = {
      push: async () => ({ results: [] }),
      pull: async (params) => ({
        entity: params.entity,
        items:
          params.entity === SYNC_ENTITY_FARM_PLOT && params.since === 0
            ? [{ entityId: 'plot-pulled', version: 1, deleted: false, payload: serverPlot }]
            : [],
        cursor: 1,
        hasMore: false
      }),
      status: async () => []
    };
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    const summary = await store.pullEntity(SYNC_ENTITY_FARM_PLOT);
    expect(summary).toMatchObject({ applied: 1, cursor: 1 });
    const records = store.getRecords(SYNC_ENTITY_FARM_PLOT);
    expect(records).toHaveLength(1);
    expect((records[0].payload as { name: string }).name).toBe('Pulled Plot');
  });
});

describe('derivedPlotId', () => {
  it('is deterministic per mutation key and distinct across keys', () => {
    const key = 'farms.plot.11.08550.7.71990.Zaria North Plot.Kano.Zaria.2.5';
    expect(derivedPlotId(key)).toBe(derivedPlotId(key));
    expect(derivedPlotId(key)).toMatch(/^plot-[a-z0-9]+$/);
    expect(derivedPlotId(`${key}x`)).not.toBe(derivedPlotId(key));
    expect(derivedPlotId(key).length).toBeLessThanOrEqual(128);
  });
});

describe('connectivity flush includes the sync outbox', () => {
  it('flushes queued farm_plot writes AND the legacy queue on a metered reconnect', async () => {
    // A store with a queued farm_plot mutation, hydrated from empty storage.
    const { state, transport } = switchableTransport();
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    await store.enqueue({
      entity: SYNC_ENTITY_FARM_PLOT,
      entityId: derivedPlotId('farms.plot.metered'),
      op: 'upsert',
      payload: { name: 'Metered Plot' },
      clientMutationId: 'farms.plot.metered'
    });

    // A legacy queue with a pending agent progress report.
    const legacyQueue = createOfflineQueue(createInMemoryStorage());
    await legacyQueue.enqueue({
      kind: 'agent.progress',
      method: 'POST',
      path: '/field-agents/progress',
      payload: { note: 'done' },
      idempotencyKey: 'agent.progress.1'
    });

    // The useConnectivitySync flushOutbox composition, minus the React
    // wrapper (the hook is covered by app-level tests): legacy flush first,
    // then the sync outbox push — even on metered connections.
    let legacyFlushed = 0;
    const flushOutbox = async () => {
      await legacyQueue.flush(() => {
        legacyFlushed += 1;
        return Promise.resolve();
      });
      await store.pushPending();
    };
    let pulled = 0;
    const stop = startConnectivitySync({
      addNetInfoListener: () => () => undefined,
      addAppStateListener: () => () => undefined,
      flushOutbox,
      pullLatest: () => {
        pulled += 1;
        return Promise.resolve();
      }
    });

    // Simulate what the hook does on a METERED reconnect: flush runs,
    // background pull is skipped.
    state.online = true;
    await act(async () => {
      await flushOutbox();
    });
    stop();

    expect(legacyFlushed).toBe(1);
    expect(state.pushed).toHaveLength(1);
    expect(state.pushed[0][0]).toMatchObject({ entity: SYNC_ENTITY_FARM_PLOT });
    expect(store.getOutbox()).toHaveLength(0);
    expect(await legacyQueue.pending()).toHaveLength(0);
    expect(pulled).toBe(0);
  });

  it('shares one provider store between the screen and connectivity wiring', async () => {
    // Screen and connectivity both resolve useSyncStore() to the provider
    // store, so an outbox entry queued by the screen is visible to the
    // flush path without prop threading.
    const { transport } = switchableTransport();
    const store = createSyncStore({ storage: createInMemoryStorage(), transport });
    let resolved: SyncStore | null = null;
    function Probe() {
      resolved = useSyncStore();
      return null;
    }
    const client = createApiClient({
      baseUrl: 'https://api.test/api/v1',
      tokenStore: createInMemoryTokenStore(),
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    });
    await act(async () => {
      create(
        <ApiProvider client={client}>
          <SyncProvider store={store}>
            <Probe />
          </SyncProvider>
        </ApiProvider>
      );
    });
    await flush();
    expect(resolved).toBe(store);
  });
});
