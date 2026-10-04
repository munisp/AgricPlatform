import { act, type ReactElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { buildPlaceOrderBody } from '../src/api/endpoints';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { createInMemoryStorage, createOfflineQueue } from '../src/offline/queue';
import { ListingDetailScreen } from '../src/screens/ListingDetailScreen';
import { MarketplaceScreen } from '../src/screens/MarketplaceScreen';
import { SyncProvider } from '../src/sync/context';
import { SYNC_ENTITIES, SYNC_ENTITY_MARKETPLACE_LISTING } from '../src/sync/entities';
import { createSyncStore, type SyncStore, type SyncTransport } from '../src/sync/store';
import { createApiSyncTransport } from '../src/sync/transport';

/**
 * GAP-H11 (buy action + offline order queueing) and GAP-M26
 * (marketplace_listing sync pull + offline cache) contract tests.
 */

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

function clientFor(fetchImpl: typeof fetch): ApiClient {
  return createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
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
  return { client: clientFor(fetchImpl), calls };
}

async function render(ui: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(ui);
  });
  await flush();
  return renderer!;
}

const SESSION = {
  data: {
    user: { id: 'user-1', phone: '+234801', fullName: 'Adamu', roles: ['farmer'], preferredLanguage: 'en' }
  }
};

const LISTING = {
  id: 'listing-1',
  sellerId: 'seller-9',
  kind: 'produce',
  title: 'Maize (100kg bags)',
  quantity: 40,
  unit: 'bag',
  priceNaira: 38000,
  location: { state: 'Kano', lga: 'Kura' },
  isActive: true
};

const ORDER = {
  id: 'order-1',
  listingId: 'listing-1',
  buyerId: 'user-1',
  sellerId: 'seller-9',
  quantity: 1,
  totalNaira: 38000,
  status: 'placed',
  escrowRequired: false,
  createdAt: '2026-07-20T00:00:00.000Z'
};

/* --------------------------- GAP-H11: buy action ------------------------ */

describe('ListingDetailScreen — buy action (GAP-H11)', () => {
  it('places an order online through the queue with the shared body-builder', async () => {
    const api = stubApi({
      '/auth/session': SESSION,
      '/listings/listing-1/orders': { data: ORDER },
      '/listings/listing-1': { data: LISTING }
    });
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await render(
      <ApiProvider client={api.client}>
        <ListingDetailScreen listingId="listing-1" queue={queue} />
      </ApiProvider>
    );
    expect(screenText(renderer.root)).toContain('Maize (100kg bags)');

    await interact(() => pressByLabel(renderer.root, 'Place order'));

    const post = api.calls.find(
      (call) => call.url.endsWith('/listings/listing-1/orders') && call.init?.method === 'POST'
    );
    expect(post).toBeTruthy();
    // Online body comes from the queue entry payload — which is built by the
    // SAME body-builder as the direct wrapper (byte-identical replay).
    expect(JSON.parse(String(post?.init?.body))).toEqual(
      buildPlaceOrderBody({ buyerId: 'user-1', quantity: 1 })
    );
    expect((post?.init?.headers as Record<string, string>)['Idempotency-Key']).toContain(
      'marketplace.order:listing-1:user-1:'
    );
    expect(await queue.pending()).toHaveLength(0);
    expect(screenText(renderer.root)).toContain('Order placed');
  });

  it('queues the order offline and the replay sends the identical body', async () => {
    let online = false;
    const calls: StubbedApi['calls'] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (init?.method === 'POST' && !online) {
        throw new TypeError('network down');
      }
      if (path.endsWith('/auth/session')) {
        return new Response(JSON.stringify(SESSION), { status: 200 });
      }
      if (path.endsWith('/listings/listing-1/orders')) {
        return new Response(JSON.stringify({ data: ORDER }), { status: 200 });
      }
      if (path.endsWith('/listings/listing-1')) {
        return new Response(JSON.stringify({ data: LISTING }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }) as typeof fetch;
    const client = clientFor(fetchImpl);
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await render(
      <ApiProvider client={client}>
        <ListingDetailScreen listingId="listing-1" queue={queue} />
      </ApiProvider>
    );

    await interact(() => pressByLabel(renderer.root, 'Place order'));

    // The order is parked in the queue with the TTL-honoured kind…
    const [entry] = await queue.pending();
    expect(entry).toMatchObject({
      kind: 'marketplace.order.created',
      method: 'POST',
      path: '/listings/listing-1/orders',
      chainKey: 'marketplace.listing:listing-1'
    });
    // …and the queued payload is exactly the shared body-builder's output.
    expect(entry.payload).toEqual(buildPlaceOrderBody({ buyerId: 'user-1', quantity: 1 }));
    expect(screenText(renderer.root)).toContain('queued and will be placed when you are back online');

    // Reconnect: the connectivity flush replays the SAME body + key.
    online = true;
    const result = await queue.flush((request) =>
      client.apiFetch(request.path, {
        method: request.method,
        body: request.payload,
        idempotencyKey: request.idempotencyKey
      })
    );
    expect(result.sent).toBe(1);
    expect(await queue.pending()).toHaveLength(0);
    const replay = calls.find(
      (call) => call.url.endsWith('/listings/listing-1/orders') && call.init?.method === 'POST'
    );
    expect(JSON.parse(String(replay?.init?.body))).toEqual(entry.payload);
    expect((replay?.init?.headers as Record<string, string>)['Idempotency-Key']).toBe(
      entry.idempotencyKey
    );
  });

  it('refuses to order your own listing', async () => {
    const api = stubApi({
      '/auth/session': SESSION,
      '/listings/listing-1': { data: { ...LISTING, sellerId: 'user-1' } }
    });
    const queue = createOfflineQueue(createInMemoryStorage());
    const renderer = await render(
      <ApiProvider client={api.client}>
        <ListingDetailScreen listingId="listing-1" queue={queue} />
      </ApiProvider>
    );

    await interact(() => pressByLabel(renderer.root, 'Place order'));

    expect(screenText(renderer.root)).toContain('your own listing');
    expect(api.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    expect(await queue.pending()).toHaveLength(0);
  });
});

/* ----------------- GAP-M26: marketplace_listing sync cache --------------- */

function listingPullBody(items: unknown[], cursor: number, hasMore = false) {
  return { data: { entity: SYNC_ENTITY_MARKETPLACE_LISTING, items, cursor, hasMore } };
}

async function seedListingStore(
  storage: ReturnType<typeof createInMemoryStorage>,
  listings: Array<Record<string, unknown>>
): Promise<void> {
  const seedTransport: SyncTransport = {
    pull: async () => ({
      entity: SYNC_ENTITY_MARKETPLACE_LISTING,
      items: listings.map((listing, index) => ({
        entityId: String(listing.id),
        version: index + 1,
        deleted: false,
        payload: listing
      })),
      cursor: listings.length,
      hasMore: false
    }),
    push: async () => ({ results: [] }),
    status: async () => []
  };
  await createSyncStore({ storage, transport: seedTransport }).pullEntity(
    SYNC_ENTITY_MARKETPLACE_LISTING
  );
}

function renderWithStore(api: StubbedApi, store: SyncStore): Promise<ReactTestRenderer> {
  return render(
    <ApiProvider client={api.client}>
      <SyncProvider store={store}>
        <MarketplaceScreen onOpenListing={() => {}} />
      </SyncProvider>
    </ApiProvider>
  );
}

describe('MarketplaceScreen — marketplace_listing sync cache (GAP-M26)', () => {
  it('includes marketplace_listing in the connectivity sync pull set', () => {
    expect(SYNC_ENTITIES).toContain(SYNC_ENTITY_MARKETPLACE_LISTING);
  });

  it('merges synced own listings into the live list (deduped by id)', async () => {
    const api = stubApi({
      '/sync/pull': listingPullBody(
        [{ entityId: 'listing-1', version: 1, deleted: false, payload: LISTING }],
        1
      ),
      '/listings': {
        data: [
          {
            ...LISTING,
            id: 'listing-2',
            sellerId: 'seller-4',
            title: 'Fresh tomatoes (crate)'
          }
        ]
      }
    });
    const store = createSyncStore({
      storage: createInMemoryStorage(),
      transport: createApiSyncTransport(api.client)
    });
    const renderer = await renderWithStore(api, store);

    const text = screenText(renderer.root);
    expect(text).toContain('Fresh tomatoes (crate)'); // live listing
    expect(text).toContain('Maize (100kg bags)'); // synced own listing merged in
    expect(text).not.toContain('last synced listings');
    expect(api.calls.some((call) => call.url.includes('/sync/pull'))).toBe(true);
  });

  it('serves the last synced listings with an honest notice when offline', async () => {
    const storage = createInMemoryStorage();
    await seedListingStore(storage, [LISTING]);

    const offlineClient = clientFor((async () => {
      throw new TypeError('network down');
    }) as typeof fetch);
    const api: StubbedApi = { client: offlineClient, calls: [] };
    const store = createSyncStore({ storage, transport: createApiSyncTransport(offlineClient) });

    const renderer = await renderWithStore(api, store);
    const text = screenText(renderer.root);
    expect(text).toContain('Maize (100kg bags)'); // cached data, no loss
    expect(text).toContain('offline — showing your last synced listings');
  });

  it('keeps the retryable error when offline with an empty cache', async () => {
    const api = stubApi({});
    const store = createSyncStore({
      storage: createInMemoryStorage(),
      transport: createApiSyncTransport(api.client)
    });
    const renderer = await renderWithStore(api, store);
    const text = screenText(renderer.root);
    expect(text).toContain('Retry');
    expect(text).not.toContain('last synced listings');
  });
});
