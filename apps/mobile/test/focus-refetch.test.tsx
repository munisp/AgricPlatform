/**
 * Stale-list tests (audit P1-9): list screens refetch when they regain
 * focus (the PlotCapture onSaved → goBack path) and support pull-to-refresh
 * via RefreshControl.
 */
import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { RefreshControl } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore } from '../src/api/token-store';
import { FarmsScreen } from '../src/screens/FarmsScreen';

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const PLOT = {
  id: 'plot-new',
  ownerUserId: 'user-1',
  name: 'Fresh Plot',
  state: 'Kano',
  lga: 'Kura',
  centroidLat: 11.5,
  centroidLong: 8.1,
  sizeHectares: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1
};

/** Fake navigation exposing the focus-listener surface the hook uses. */
function fakeNavigation() {
  const focusListeners = new Set<() => void>();
  return {
    navigation: {
      addListener(type: string, cb: () => void) {
        if (type === 'focus') focusListeners.add(cb);
        return () => focusListeners.delete(cb);
      }
    },
    emitFocus() {
      for (const cb of [...focusListeners]) cb();
    }
  };
}

function stubPlotsApi(sequence: unknown[][]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const data = sequence[Math.min(calls, sequence.length - 1)];
    calls += 1;
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  const client: ApiClient = createApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokenStore: createInMemoryTokenStore(),
    fetchImpl
  });
  return { client, listCalls: () => calls };
}

async function renderFarms(client: ApiClient, navigation: unknown): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  const tree: ReactNode = (
    <ApiProvider client={client}>
      <NavigationContext.Provider value={navigation as never}>
        <FarmsScreen />
      </NavigationContext.Provider>
    </ApiProvider>
  );
  await act(async () => {
    renderer = create(tree);
  });
  await flush();
  return renderer!;
}

describe('list screens: focus refetch + pull-to-refresh (P1-9)', () => {
  it('refetches when the screen regains focus — a plot saved via PlotCapture appears after goBack', async () => {
    // First load: no plots. After the capture round-trip the server has one.
    const api = stubPlotsApi([[], [PLOT]]);
    const { navigation, emitFocus } = fakeNavigation();
    const renderer = await renderFarms(api.client, navigation);

    expect(screenText(renderer.root)).toContain('No plots yet');
    expect(api.listCalls()).toBe(1);

    await act(async () => {
      emitFocus(); // goBack() from PlotCapture refocuses the list
    });
    await flush();

    expect(api.listCalls()).toBe(2);
    const text = screenText(renderer.root);
    expect(text).toContain('My plots (1)');
    expect(text).toContain('Fresh Plot');
  });

  it('pull-to-refresh reloads the list through RefreshControl', async () => {
    const api = stubPlotsApi([[], [PLOT]]);
    const { navigation } = fakeNavigation();
    const renderer = await renderFarms(api.client, navigation);
    expect(screenText(renderer.root)).toContain('No plots yet');

    const control = renderer.root.findByType(RefreshControl as never);
    await act(async () => {
      await (control.props as { onRefresh: () => Promise<void> }).onRefresh();
    });
    await flush();

    expect(api.listCalls()).toBe(2);
    expect(screenText(renderer.root)).toContain('Fresh Plot');
  });

  it('still loads on mount when rendered without a navigation container', async () => {
    const api = stubPlotsApi([[PLOT]]);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ApiProvider client={api.client}>
          <FarmsScreen />
        </ApiProvider>
      );
    });
    await flush();
    expect(api.listCalls()).toBe(1);
    expect(screenText(renderer!.root)).toContain('Fresh Plot');
  });
});
