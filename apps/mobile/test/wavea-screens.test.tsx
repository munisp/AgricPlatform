import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { HomeScreen } from '../src/screens/HomeScreen';
import { LivestockScreen } from '../src/screens/LivestockScreen';
import { NotificationsScreen } from '../src/screens/NotificationsScreen';
import { OrderDetailScreen } from '../src/screens/OrderDetailScreen';
import { OrdersScreen } from '../src/screens/OrdersScreen';

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

const SESSION = { data: { user: { id: 'user-1', phone: '+234801', fullName: 'Adamu', roles: ['farmer'], preferredLanguage: 'en' } } };

const ORDER = {
  id: 'o-1',
  listingId: 'l-1',
  buyerId: 'user-1',
  sellerId: 'user-2',
  quantity: 20,
  totalNaira: 46000,
  status: 'in_fulfilment',
  escrowRequired: true,
  createdAt: '2026-07-01T00:00:00.000Z'
};

const DRAFT = {
  id: 'd-1',
  listingId: 'l-9',
  buyerId: 'user-1',
  sellerId: 'user-3',
  quantity: 5,
  unitPriceKobo: 120000,
  status: 'open',
  createdBy: 'agent-1',
  createdAt: '2026-07-02T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z'
};

/* ------------------------------- orders --------------------------------- */

describe('OrdersScreen', () => {
  it('lists my orders with status and navigates to detail', async () => {
    const api = stubApi({
      '/auth/session': SESSION,
      '/draft-orders': { data: [] },
      '/orders': { data: [ORDER] }
    });
    let opened: string | null = null;
    const renderer = await renderWithApi(api, <OrdersScreen onOpenOrder={(id) => (opened = id)} />);

    const text = screenText(renderer.root);
    expect(text).toContain('My orders');
    expect(text).toContain('Status: in_fulfilment');

    await interact(() => pressByLabel(renderer.root, 'View order'));
    expect(opened).toBe('o-1');
  });

  it('shows an empty state when there are no orders', async () => {
    const api = stubApi({
      '/auth/session': SESSION,
      '/draft-orders': { data: [] },
      '/orders': { data: [] }
    });
    const renderer = await renderWithApi(api, <OrdersScreen onOpenOrder={() => {}} />);
    expect(screenText(renderer.root)).toContain('No orders yet');
  });

  it('lets the buyer confirm an open draft order', async () => {
    const api = stubApi({
      '/auth/session': SESSION,
      '/draft-orders/d-1/confirm': { data: { ...DRAFT, status: 'confirmed', orderId: 'o-9' } },
      '/draft-orders': { data: [DRAFT] },
      '/orders': { data: [] }
    });
    const renderer = await renderWithApi(api, <OrdersScreen onOpenOrder={() => {}} />);

    expect(screenText(renderer.root)).toContain('Draft orders to confirm');
    await interact(() => pressByLabel(renderer.root, 'Confirm order'));

    const confirm = api.calls.find((call) => call.url.endsWith('/draft-orders/d-1/confirm'));
    expect(confirm?.init?.method).toBe('POST');
  });
});

describe('OrderDetailScreen', () => {
  it('renders the status timeline with completed steps ticked', async () => {
    const api = stubApi({ '/orders/o-1': { data: ORDER } });
    const renderer = await renderWithApi(api, <OrderDetailScreen orderId="o-1" />);

    const text = screenText(renderer.root);
    expect(text).toContain('Order o-1');
    expect(text).toContain('Order placed');
    expect(text).toContain('Being prepared');
    expect(text).toContain('Completed');
    // In fulfilment: placed + deposit_paid + in_fulfilment reached.
    expect(text).toContain('✓');
    expect(text).toContain('escrow protected');
  });

  it('explains terminal states instead of ticking the timeline', async () => {
    const api = stubApi({ '/orders/o-2': { data: { ...ORDER, id: 'o-2', status: 'cancelled' } } });
    const renderer = await renderWithApi(api, <OrderDetailScreen orderId="o-2" />);
    expect(screenText(renderer.root)).toContain('This order is cancelled.');
  });
});

/* ---------------------------- notifications ------------------------------ */

const NOTIFICATION = {
  id: 'n-1',
  userId: 'user-1',
  channel: 'in_app',
  title: 'Anthrax recall in Kano',
  body: 'Vaccinate cattle before movement.',
  status: 'delivered',
  createdAt: '2026-07-03T00:00:00.000Z'
};

describe('NotificationsScreen', () => {
  it('lists notifications and marks one read', async () => {
    const api = stubApi({
      '/auth/session': SESSION,
      '/notifications/n-1/read': { data: { ...NOTIFICATION, status: 'read' } },
      '/notifications': { data: [NOTIFICATION] }
    });
    const renderer = await renderWithApi(api, <NotificationsScreen />);

    expect(screenText(renderer.root)).toContain('Anthrax recall in Kano');
    await interact(() => pressByLabel(renderer.root, 'Mark read'));

    const mark = api.calls.find((call) => call.url.endsWith('/notifications/n-1/read'));
    expect(mark?.init?.method).toBe('POST');
  });

  it('shows an empty inbox state', async () => {
    const api = stubApi({ '/auth/session': SESSION, '/notifications': { data: [] } });
    const renderer = await renderWithApi(api, <NotificationsScreen />);
    expect(screenText(renderer.root)).toContain('No notifications yet');
  });
});

/* ------------------------------ livestock -------------------------------- */

const ANIMAL = {
  id: 'NG-CAP-KN-000042',
  species: 'goat',
  breed: 'Sahel',
  sex: 'female',
  ownerUserId: 'user-1',
  state: 'Kano',
  status: 'active',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z'
};

describe('LivestockScreen', () => {
  it('lists registered animals', async () => {
    const api = stubApi({ '/livestock/animals/mine': { data: [ANIMAL] } });
    const renderer = await renderWithApi(api, <LivestockScreen />);

    const text = screenText(renderer.root);
    expect(text).toContain('My animals (1)');
    expect(text).toContain('NG-CAP-KN-000042');
    expect(text).toContain('goat · Sahel · female');
  });

  it('registers an animal through the minimal form', async () => {
    const api = stubApi({
      '/livestock/animals/mine': { data: [] },
      '/livestock/animals': { data: ANIMAL }
    });
    const renderer = await renderWithApi(api, <LivestockScreen state="Kano" />);

    await interact(() => pressByLabel(renderer.root, 'Register animal'));
    await interact(() => pressByLabel(renderer.root, 'goat'));
    await interact(() => pressByLabel(renderer.root, 'Sahel'));
    await interact(() => pressByLabel(renderer.root, 'Submit registration'));

    const post = api.calls.find(
      (call) => call.url.endsWith('/livestock/animals') && call.init?.method === 'POST'
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      species: 'goat',
      breed: 'Sahel',
      sex: 'female',
      state: 'Kano'
    });
  });
});

/* --------------------------- home farm summary --------------------------- */

describe('HomeScreen farm summary', () => {
  it('renders animals, pending health tasks and active orders cards', async () => {
    const api = stubApi({
      '/pathway-enrolments/mine': { data: [] },
      '/opportunities': { data: [], total: 3, page: 1, pageSize: 1 },
      '/advisory/weather/Kano': {
        data: { state: 'Kano', temperatureCelsius: 31, humidityPercent: 40, rainfallMm: 2, outlook: 'Dry', source: 'stub' }
      },
      '/livestock/animals/mine': { data: [ANIMAL, { ...ANIMAL, id: 'NG-CAP-KN-000043' }] },
      '/livestock-health/recalls': { data: [{ id: 'r-1', status: 'active', createdAt: '2026-07-01T00:00:00.000Z' }] },
      '/auth/session': SESSION,
      '/orders': {
        data: [
          ORDER,
          { ...ORDER, id: 'o-2', status: 'completed' },
          { ...ORDER, id: 'o-3', status: 'placed' }
        ]
      }
    });
    const renderer = await renderWithApi(
      api,
      <HomeScreen
        onOpenCourses={() => {}}
        onOpenMarketplace={() => {}}
        onOpenProfile={() => {}}
        onOpenOrders={() => {}}
        onOpenNotifications={() => {}}
        onOpenLivestock={() => {}}
      />
    );

    const text = screenText(renderer.root);
    expect(text).toContain('Farm summary');
    expect(text).toContain('registered animals');
    expect(text).toContain('pending health tasks');
    // 2 animals, 1 active recall, 2 active orders (placed + in_fulfilment).
    expect(text).toContain('2');
    expect(text).toContain('active orders');
  });
});
