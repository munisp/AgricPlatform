import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { createInMemoryStorage } from '../src/offline/queue';
import { FarmsScreen } from '../src/screens/FarmsScreen';
import {
  derivedPlotId,
  PlotCaptureScreen,
  type LocationService,
  type SavedPlotSummary
} from '../src/screens/PlotCaptureScreen';
import { SYNC_ENTITY_FARM_PLOT } from '../src/sync/entities';
import { createSyncStore, type SyncPushRequestItem } from '../src/sync/store';
import { createApiSyncTransport } from '../src/sync/transport';

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
    .map((node) => flattenText(node.props.children))
    .join('\n');
}

function pressByLabel(root: ReactTestInstance, label: string): void {
  const target = root
    .findAllByType('rn-pressable' as never)
    .find((node) => flattenText(node).includes(label));
  if (!target) throw new Error(`No pressable labelled "${label}"`);
  (target.props as { onPress?: () => void }).onPress?.();
}

/** Types into the nth TextInput on the screen (0 = first). */
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

interface StubbedApi {
  client: ApiClient;
  calls: Array<{ url: string; init?: RequestInit }>;
}

function stubApi(routes: Record<string, unknown>): StubbedApi {
  const calls: StubbedApi['calls'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    for (const [route, body] of Object.entries(routes)) {
      if (path.endsWith(route)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
  return { client, calls };
}

async function renderWithApi(api: StubbedApi, ui: ReactNode): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ApiProvider client={api.client}>{ui}</ApiProvider>);
  });
  await flush();
  return renderer!;
}

const PLOT = {
  id: 'plot-1',
  ownerUserId: 'user-1',
  name: 'Zaria North Plot',
  state: 'Kano',
  lga: 'Zaria',
  centroidLat: 11.0855,
  centroidLong: 7.7199,
  sizeHectares: 2.5,
  soilType: 'loamy',
  createdAt: '2026-04-12T08:00:00.000Z',
  updatedAt: '2026-07-18T09:30:00.000Z',
  version: 3
};

/* ------------------------------ FarmsScreen ----------------------------- */

describe('FarmsScreen', () => {
  it('lists my plots', async () => {
    const api = stubApi({ '/farms/plots': { data: [PLOT] } });
    const renderer = await renderWithApi(api, <FarmsScreen />);

    const text = screenText(renderer.root);
    expect(text).toContain('My plots (1)');
    expect(text).toContain('Zaria North Plot');
    expect(text).toContain('2.5 ha');
  });

  it('shows the empty state and capture entry point', async () => {
    const api = stubApi({ '/farms/plots': { data: [] } });
    let capture = false;
    const renderer = await renderWithApi(
      api,
      <FarmsScreen onCapturePlot={() => (capture = true)} />
    );

    expect(screenText(renderer.root)).toContain('No plots yet');
    await interact(() => pressByLabel(renderer.root, 'Capture plot'));
    expect(capture).toBe(true);
  });

  it('shows a retryable error when loading fails', async () => {
    const api = stubApi({});
    const renderer = await renderWithApi(api, <FarmsScreen />);
    const text = screenText(renderer.root);
    expect(text).toContain('Something went wrong');
    expect(text).toContain('Retry');
  });
});

/* --------------------------- PlotCaptureScreen -------------------------- */

const gps: LocationService = {
  getCurrentPoint: () => Promise.resolve({ lat: 11.0855, long: 7.7199, accuracyMeters: 6 })
};

/**
 * Online client whose /sync/push applies every item — a minimal server
 * double for the record-level sync outbox (W-SYNCWRITE).
 */
function syncApi(
  respond?: (items: SyncPushRequestItem[]) => unknown[],
  extraRoutes: Record<string, unknown> = {}
): StubbedApi {
  const calls: StubbedApi['calls'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path.endsWith('/sync/push')) {
      const items = (JSON.parse(String(init?.body)) as { items: SyncPushRequestItem[] }).items;
      const results = respond
        ? respond(items)
        : items.map((item) => ({
            entity: item.entity,
            entityId: item.entityId,
            clientMutationId: item.clientMutationId,
            status: 'applied',
            newVersion: item.baseVersion + 1
          }));
      return new Response(JSON.stringify({ data: { results } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    for (const [route, body] of Object.entries(extraRoutes)) {
      if (path.endsWith(route)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  const client = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
  return { client, calls };
}

function storeFor(client: ApiClient) {
  return createSyncStore({
    storage: createInMemoryStorage(),
    transport: createApiSyncTransport(client)
  });
}

describe('PlotCaptureScreen', () => {
  it('captures a centroid and boundary and saves through the sync outbox', async () => {
    const api = syncApi();
    const store = storeFor(api.client);
    let saved: SavedPlotSummary | null = null;
    const renderer = await renderWithApi(
      api,
      <PlotCaptureScreen
        state="Kano"
        locationService={gps}
        store={store}
        onSaved={(plot) => (saved = plot)}
      />
    );

    await interact(() => setInputAt(renderer.root, 0, 'Zaria North Plot')); // name
    await interact(() => setInputAt(renderer.root, 1, 'Zaria')); // lga
    await interact(() => setInputAt(renderer.root, 2, '2.5')); // size
    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer.root, 'Add boundary point'));
    await interact(() => pressByLabel(renderer.root, 'Add boundary point'));
    await interact(() => pressByLabel(renderer.root, 'Add boundary point'));

    let text = screenText(renderer.root);
    expect(text).toContain('11.08550, 7.71990');
    expect(text).toContain('Boundary (3 points)');

    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    // The capture went out as ONE record-level sync push item…
    const post = api.calls.find(
      (call) => call.url.endsWith('/sync/push') && call.init?.method === 'POST'
    );
    expect(post).toBeTruthy();
    const { items } = JSON.parse(String(post?.init?.body)) as { items: SyncPushRequestItem[] };
    expect(items).toHaveLength(1);
    expect(items[0].entity).toBe(SYNC_ENTITY_FARM_PLOT);
    expect(items[0].op).toBe('upsert');
    expect(items[0].baseVersion).toBe(0);
    expect(items[0].clientMutationId).toContain('farms.plot.');
    expect(items[0].entityId).toBe(derivedPlotId(items[0].clientMutationId));
    const payload = items[0].payload as Record<string, unknown>;
    expect(payload.name).toBe('Zaria North Plot');
    expect(payload.state).toBe('Kano');
    const boundary = payload.boundaryGeojson as { type: string; coordinates: unknown[][] };
    expect(boundary.type).toBe('Polygon');
    expect(boundary.coordinates[0]).toHaveLength(4); // closed ring
    // …and NEVER as a legacy-queue POST /farms/plots (dual-write closed).
    expect(api.calls.filter((call) => call.url.endsWith('/farms/plots'))).toHaveLength(0);

    expect(saved).toMatchObject({ id: items[0].entityId, synced: true, version: 1 });
    expect(store.getOutbox()).toHaveLength(0);
    text = screenText(renderer.root);
    expect(text).toContain('Plot saved.');
  });

  it('keeps the plot in the sync outbox when the network is down', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.test/api/v1',
      tokenStore: createInMemoryTokenStore(),
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    });
    const store = storeFor(client);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ApiProvider client={client}>
          <PlotCaptureScreen state="Kano" locationService={gps} store={store} />
        </ApiProvider>
      );
    });
    await flush();

    await interact(() => setInputAt(renderer!.root, 0, 'Offline Plot'));
    await interact(() => setInputAt(renderer!.root, 1, 'Kura'));
    await interact(() => setInputAt(renderer!.root, 2, '1'));
    await interact(() => pressByLabel(renderer!.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer!.root, 'Save plot'));

    const outbox = store.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      entity: SYNC_ENTITY_FARM_PLOT,
      op: 'upsert',
      baseVersion: 0
    });
    expect(outbox[0].payload).toMatchObject({ name: 'Offline Plot', lga: 'Kura' });
    expect(screenText(renderer!.root)).toContain('queued');
  });

  it('requires a GPS centre point before saving', async () => {
    const api = syncApi();
    const store = storeFor(api.client);
    const renderer = await renderWithApi(
      api,
      <PlotCaptureScreen state="Kano" locationService={gps} store={store} />
    );

    await interact(() => setInputAt(renderer.root, 0, 'No GPS Plot'));
    await interact(() => setInputAt(renderer.root, 1, 'Kura'));
    await interact(() => setInputAt(renderer.root, 2, '1'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    expect(screenText(renderer.root)).toContain('Capture the plot centre point first');
    expect(api.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(store.getOutbox()).toHaveLength(0);
  });

  it('fails closed when no GPS provider is configured', async () => {
    const api = stubApi({ '/farms/plots': { data: PLOT } });
    const renderer = await renderWithApi(api, <PlotCaptureScreen state="Kano" />);

    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    expect(screenText(renderer.root)).toContain('No GPS provider configured');
  });
});
