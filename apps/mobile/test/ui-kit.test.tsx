import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import {
  EmptyState,
  FormField,
  ListItem,
  MetricTile,
  PrimaryButton,
  SectionCard,
  StatusPill,
  tokens
} from '../src/screens/ui';
import { HUB_TILES, HomeScreen, orderTilesForRoles } from '../src/screens/HomeScreen';

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

/** Flatten a (possibly nested array) style prop into one object. */
function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flatStyle(entry) }), {});
  }
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function stubApi(routes: Record<string, unknown>) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
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
  const client: ApiClient = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
  return { client };
}

async function renderWithApi(api: { client: ApiClient }, ui: ReactNode): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ApiProvider client={api.client}>{ui}</ApiProvider>);
  });
  await flush();
  return renderer!;
}

const homeProps = {
  onOpenCourses: () => {},
  onOpenMarketplace: () => {},
  onOpenProfile: () => {},
  onOpenOrders: () => {},
  onOpenNotifications: () => {},
  onOpenLivestock: () => {}
};

const baseRoutes = {
  '/pathway-enrolments/mine': { data: [] },
  '/opportunities': { data: [], total: 0, page: 1, pageSize: 1 }
};

/* -------------------------------- tests ---------------------------------- */

describe('mobile UI kit v2 primitives', () => {
  it('StatusPill renders the label with tone-matched colors', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<StatusPill tone="success" label="Available" />);
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('Available');
    const pill = renderer!.root.findAllByType('rn-view' as never)[0];
    expect(flatStyle(pill.props.style).backgroundColor).toBe(tokens.colors.green100);
  });

  it('SectionCard renders kicker, title and action slot', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <SectionCard kicker="Products" title="Explore" action={<StatusPill tone="info" label="3 new" />}>
          <MetricTile value={7} label="open items" />
        </SectionCard>
      );
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('Products');
    expect(text).toContain('Explore');
    expect(text).toContain('3 new');
    expect(text).toContain('7');
    expect(text).toContain('open items');
  });

  it('EmptyState renders title, hint and fires its action', async () => {
    const onAction = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <EmptyState title="Not set up yet" hint="Connect a driver to begin." actionLabel="Set up" onAction={onAction} />
      );
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('Not set up yet');
    expect(text).toContain('Connect a driver to begin.');
    pressByLabel(renderer!.root, 'Set up');
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('MetricTile shows a down-trend with the clay tone', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<MetricTile value="42" label="active orders" trend="8%" trendDown />);
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('▼ 8%');
  });

  it('FormField shows the hint, then replaces it with a live-region error', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <FormField label="Phone number" hint="Used for OTP sign-in">
          <TextInput accessibilityLabel="Phone number" />
        </FormField>
      );
    });
    expect(screenText(renderer!.root)).toContain('Used for OTP sign-in');

    await act(async () => {
      renderer!.update(
        <FormField label="Phone number" hint="Used for OTP sign-in" error="Enter a valid phone number.">
          <TextInput accessibilityLabel="Phone number" />
        </FormField>
      );
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('Enter a valid phone number.');
    expect(text).not.toContain('Used for OTP sign-in');
    const errorNode = renderer!.root
      .findAllByType('rn-text' as never)
      .find((node) => flattenText(node.props.children).includes('Enter a valid'));
    expect((errorNode!.props as { accessibilityLiveRegion?: string }).accessibilityLiveRegion).toBe(
      'polite'
    );
  });

  it('ListItem renders a chevron when tappable and fires onPress', async () => {
    const onPress = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ListItem title="My orders" subtitle="2 active" onPress={onPress} />);
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('My orders');
    expect(text).toContain('2 active');
    expect(text).toContain('›');
    pressByLabel(renderer!.root, 'My orders');
    expect(onPress).toHaveBeenCalledTimes(1);
    // 44pt+ touch target.
    const row = renderer!.root.findAllByType('rn-pressable' as never)[0];
    expect(Number(flatStyle(row.props.style).minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('PrimaryButton meets the 44pt touch-target floor', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<PrimaryButton label="Save" onPress={() => {}} />);
    });
    const button = renderer!.root.findAllByType('rn-pressable' as never)[0];
    expect(Number(flatStyle(button.props.style).minHeight)).toBeGreaterThanOrEqual(44);
  });
});

describe('HomeScreen hub grid', () => {
  it('renders a tile for every wired callback and omits unwired ones', async () => {
    const api = stubApi(baseRoutes);
    const renderer = await renderWithApi(api, <HomeScreen {...homeProps} />);
    const text = screenText(renderer.root);
    expect(text).toContain('Explore');
    expect(text).toContain('Browse courses');
    expect(text).toContain('My livestock');
    // onOpenFarms / onOpenAgentQueue not wired → tiles hidden.
    expect(text).not.toContain('My plots');
    expect(text).not.toContain('My field queue');
  });

  it('tile presses route to the matching callback', async () => {
    const onOpenLivestock = vi.fn();
    const api = stubApi(baseRoutes);
    const renderer = await renderWithApi(
      api,
      <HomeScreen {...homeProps} onOpenLivestock={onOpenLivestock} />
    );
    pressByLabel(renderer.root, 'My livestock');
    expect(onOpenLivestock).toHaveBeenCalledTimes(1);
  });

  it('orders tiles by role (enumerator sees the field queue first)', () => {
    const ordered = orderTilesForRoles(HUB_TILES, ['enumerator']);
    expect(ordered[0].id).toBe('agentQueue');
    expect(ordered[1].id).toBe('farms');
    // Unknown roles keep the registry order untouched.
    const fallback = orderTilesForRoles(HUB_TILES, ['admin']);
    expect(fallback.map((tile) => tile.id)).toEqual(HUB_TILES.map((tile) => tile.id));
  });
});
