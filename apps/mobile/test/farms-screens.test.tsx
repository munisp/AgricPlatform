import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { createInMemoryStorage, createOfflineQueue } from '../src/offline/queue';
import { FarmsScreen } from '../src/screens/FarmsScreen';
import {
  PlotCaptureScreen,
  type LocationService
} from '../src/screens/PlotCaptureScreen';

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

describe('PlotCaptureScreen', () => {
  it('captures a centroid and boundary and saves through the queue', async () => {
    const api = stubApi({ '/farms/plots': { data: PLOT } });
    const queue = createOfflineQueue(createInMemoryStorage());
    let saved: string | null = null;
    const renderer = await renderWithApi(
      api,
      <PlotCaptureScreen
        state="Kano"
        locationService={gps}
        queue={queue}
        onSaved={(plot) => (saved = plot.id)}
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

    const post = api.calls.find(
      (call) => call.url.endsWith('/farms/plots') && call.init?.method === 'POST'
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post?.init?.body));
    expect(body.name).toBe('Zaria North Plot');
    expect(body.state).toBe('Kano');
    expect(body.boundaryGeojson.type).toBe('Polygon');
    expect(body.boundaryGeojson.coordinates[0]).toHaveLength(4); // closed ring
    // The queue replay and the server dedupe on the same idempotency key.
    expect(post?.init?.headers).toMatchObject({
      'Idempotency-Key': expect.stringContaining('farms.plot.')
    });
    expect(saved).toBe('plot-1');
    expect(await queue.pending()).toHaveLength(0);
    text = screenText(renderer.root);
    expect(text).toContain('Plot saved.');
  });

  it('keeps the plot queued when the network is down', async () => {
    const client = createApiClient({
      baseUrl: 'https://api.test/api/v1',
      tokenStore: createInMemoryTokenStore(),
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    });
    const queue = createOfflineQueue(createInMemoryStorage());
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ApiProvider client={client}>
          <PlotCaptureScreen state="Kano" locationService={gps} queue={queue} />
        </ApiProvider>
      );
    });
    await flush();

    await interact(() => setInputAt(renderer!.root, 0, 'Offline Plot'));
    await interact(() => setInputAt(renderer!.root, 1, 'Kura'));
    await interact(() => setInputAt(renderer!.root, 2, '1'));
    await interact(() => pressByLabel(renderer!.root, 'Capture centre point'));
    await interact(() => pressByLabel(renderer!.root, 'Save plot'));

    const pending = await queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('farms.plot.created');
    expect(pending[0].path).toBe('/farms/plots');
    expect(screenText(renderer!.root)).toContain('queued');
  });

  it('requires a GPS centre point before saving', async () => {
    const api = stubApi({ '/farms/plots': { data: PLOT } });
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await renderWithApi(
      api,
      <PlotCaptureScreen state="Kano" locationService={gps} queue={queue} />
    );

    await interact(() => setInputAt(renderer.root, 0, 'No GPS Plot'));
    await interact(() => setInputAt(renderer.root, 1, 'Kura'));
    await interact(() => setInputAt(renderer.root, 2, '1'));
    await interact(() => pressByLabel(renderer.root, 'Save plot'));

    expect(screenText(renderer.root)).toContain('Capture the plot centre point first');
    expect(api.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(await queue.pending()).toHaveLength(0);
  });

  it('fails closed when no GPS provider is configured', async () => {
    const api = stubApi({ '/farms/plots': { data: PLOT } });
    const renderer = await renderWithApi(api, <PlotCaptureScreen state="Kano" />);

    await interact(() => pressByLabel(renderer.root, 'Capture centre point'));
    expect(screenText(renderer.root)).toContain('No GPS provider configured');
  });
});
