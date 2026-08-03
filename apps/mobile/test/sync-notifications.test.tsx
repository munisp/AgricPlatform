import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { createInMemoryStorage } from '../src/offline/queue';
import { NotificationsScreen } from '../src/screens/NotificationsScreen';
import { SyncProvider } from '../src/sync/context';
import { createSyncStore, type SyncTransport } from '../src/sync/store';
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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

async function renderWithApi(
  api: StubbedApi,
  ui: ReactNode,
  store?: ReturnType<typeof createSyncStore>
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <ApiProvider client={api.client}>
        {store ? <SyncProvider store={store}>{ui}</SyncProvider> : ui}
      </ApiProvider>
    );
  });
  await flush();
  return renderer!;
}

const SESSION = {
  data: { user: { id: 'user-1', phone: '+234801', fullName: 'Adamu', roles: ['farmer'], preferredLanguage: 'en' } }
};

const NOTIFICATION = {
  id: 'n-1',
  userId: 'user-1',
  channel: 'in_app',
  title: 'Anthrax recall in Kano',
  body: 'Vaccinate cattle before movement.',
  status: 'delivered',
  createdAt: '2026-07-03T00:00:00.000Z'
};

function syncPullBody(items: unknown[], cursor: number, hasMore = false) {
  return { data: { entity: 'notification', items, cursor, hasMore } };
}

/* -------------------------------- tests --------------------------------- */

describe('NotificationsScreen — sync read-through (Wave SYNCCLIENT)', () => {
  it('renders notifications from the sync cache after a pull', async () => {
    const api = stubApi({
      '/sync/pull': syncPullBody([{ entityId: 'n-1', version: 1, deleted: false, payload: NOTIFICATION }], 1)
    });
    const renderer = await renderWithApi(api, <NotificationsScreen />);

    const text = screenText(renderer.root);
    expect(text).toContain('Anthrax recall in Kano');
    expect(text).toContain('Synced');
    expect(text).not.toContain('offline');
    expect(api.calls.some((call) => call.url.includes('/sync/pull'))).toBe(true);
    // The legacy endpoint is not touched when the sync cache serves.
    expect(api.calls.some((call) => new URL(call.url).pathname.endsWith('/notifications'))).toBe(false);
  });

  it('applies tombstones pulled from the server (deleted records disappear)', async () => {
    const api = stubApi({
      '/sync/pull': syncPullBody(
        [
          { entityId: 'n-1', version: 1, deleted: false, payload: NOTIFICATION },
          { entityId: 'n-1', version: 2, deleted: true, payload: null }
        ],
        2
      ),
      '/notifications': { data: [NOTIFICATION] }
    });
    const renderer = await renderWithApi(api, <NotificationsScreen />);

    const text = screenText(renderer.root);
    expect(text).not.toContain('Anthrax recall in Kano');
    expect(text).toContain('No notifications yet');
  });

  it('serves the last synced cache with an honest notice when the pull fails offline', async () => {
    // Pre-seed a store whose cache already holds one notification.
    const storage = createInMemoryStorage();
    const seedTransport: SyncTransport = {
      pull: async () => ({
        entity: 'notification',
        items: [{ entityId: 'n-1', version: 1, deleted: false, payload: NOTIFICATION }],
        cursor: 1,
        hasMore: false
      }),
      push: async () => ({ results: [] }),
      status: async () => []
    };
    await createSyncStore({ storage, transport: seedTransport }).pullEntity('notification');

    // The app's api-backed transport 404s (offline/server unreachable).
    const api = stubApi({});
    const offlineClient = createApiClient({
      baseUrl: 'https://api.test/api/v1',
      tokenStore: createInMemoryTokenStore(),
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as typeof fetch
    });
    const store = createSyncStore({ storage, transport: createApiSyncTransport(offlineClient) });

    const renderer = await renderWithApi(api, <NotificationsScreen />, store);
    const text = screenText(renderer.root);
    expect(text).toContain('Anthrax recall in Kano'); // cached data, no loss
    expect(text).toContain('offline — showing your last synced notifications');
  });

  it('falls back to the legacy endpoint when sync fails and the cache is empty', async () => {
    const api = stubApi({ '/auth/session': SESSION, '/notifications': { data: [NOTIFICATION] } });
    const renderer = await renderWithApi(api, <NotificationsScreen />);

    const text = screenText(renderer.root);
    expect(text).toContain('Anthrax recall in Kano');
    expect(text).not.toContain('last synced notifications');
  });

  it('marks a notification read via the direct endpoint and re-syncs the cache', async () => {
    let readMarked = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/notifications/n-1/read')) {
        readMarked = true;
        return new Response(JSON.stringify({ data: { ...NOTIFICATION, status: 'read' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (path.endsWith('/sync/pull')) {
        return new Response(
          JSON.stringify(
            syncPullBody(
              [
                {
                  entityId: 'n-1',
                  version: readMarked ? 2 : 1,
                  deleted: false,
                  payload: readMarked ? { ...NOTIFICATION, status: 'read' } : NOTIFICATION
                }
              ],
              readMarked ? 2 : 1
            )
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }) as typeof fetch;
    const client = createApiClient({
      baseUrl: 'https://api.test/api/v1',
      tokenStore: createInMemoryTokenStore(),
      fetchImpl
    });
    const api: StubbedApi = { client, calls: [] };

    const renderer = await renderWithApi(api, <NotificationsScreen />);
    expect(screenText(renderer.root)).toContain('●');

    const target = renderer.root
      .findAllByType('rn-pressable' as never)
      .find((node) => flattenText(node).includes('Mark read'));
    expect(target).toBeDefined();
    await act(async () => {
      (target!.props as { onPress?: () => void }).onPress?.();
    });
    await flush();

    expect(readMarked).toBe(true);
    expect(screenText(renderer.root)).not.toContain('●');
  });
});
