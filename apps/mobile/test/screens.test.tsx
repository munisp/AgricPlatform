import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore, type TokenStore } from '../src/api/token-store';
import { HomeScreen } from '../src/screens/HomeScreen';
import { LoginScreen } from '../src/screens/LoginScreen';

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

function inputByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const target = root
    .findAllByType('rn-text-input' as never)
    .find((node) => (node.props as { accessibilityLabel?: string }).accessibilityLabel === label);
  if (!target) throw new Error(`No input labelled "${label}"`);
  return target;
}

/** Let pending effect/mutation promise chains settle inside act(). */
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
  tokenStore: TokenStore;
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
  const tokenStore = createInMemoryTokenStore();
  const client = createApiClient({ baseUrl: 'https://api.test/api/v1', tokenStore, fetchImpl });
  return { client, tokenStore, calls };
}

async function renderWithApi(api: StubbedApi, ui: ReactNode): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ApiProvider client={api.client}>{ui}</ApiProvider>);
  });
  await flush();
  return renderer!;
}

/* ------------------------------ login ----------------------------------- */

describe('LoginScreen', () => {
  it('renders the phone field and requests an OTP challenge', async () => {
    const api = stubApi({ '/auth/otp/request': { data: { requestId: 'req-1' } } });
    const renderer = await renderWithApi(
      api,
      <LoginScreen tokenStore={api.tokenStore} onLoggedIn={() => {}} />
    );
    const root = renderer.root;

    expect(screenText(root)).toContain('Welcome to NYFN');
    await interact(() => inputByLabel(root, 'Phone number').props.onChangeText('+2348010000004'));
    await interact(() => pressByLabel(root, 'Send code'));

    expect(api.calls.some((call) => call.url.endsWith('/auth/otp/request'))).toBe(true);
    // Step 2: the OTP field appears.
    expect(inputByLabel(root, 'One-time code')).toBeTruthy();
  });

  it('verifies the code, stores the token and reports the user', async () => {
    const api = stubApi({
      '/auth/otp/request': { data: { requestId: 'req-1' } },
      '/auth/otp/verify': {
        data: {
          token: 'stub-token.abc',
          user: {
            id: 'user-aisha',
            phone: '+2348010000004',
            fullName: 'Aisha Yusuf',
            roles: ['student'],
            preferredLanguage: 'en'
          }
        }
      }
    });
    const onLoggedIn = vi.fn();
    const renderer = await renderWithApi(
      api,
      <LoginScreen tokenStore={api.tokenStore} onLoggedIn={onLoggedIn} />
    );
    const root = renderer.root;

    await interact(() => inputByLabel(root, 'Phone number').props.onChangeText('+2348010000004'));
    await interact(() => pressByLabel(root, 'Send code'));
    await interact(() => inputByLabel(root, 'One-time code').props.onChangeText('123456'));
    await interact(() => pressByLabel(root, 'Verify and sign in'));

    expect(api.calls.some((call) => call.url.endsWith('/auth/otp/verify'))).toBe(true);
    expect(await api.tokenStore.getToken()).toBe('stub-token.abc');
    expect(onLoggedIn).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-aisha' }));
  });
});

/* ------------------------------- home ----------------------------------- */

describe('HomeScreen', () => {
  it('renders training progress, opportunities count and the weather card', async () => {
    const api = stubApi({
      '/pathway-enrolments/mine': {
        data: [
          {
            enrolment: { id: 'pe-1', templateId: 'pt-1', status: 'active' },
            template: { id: 'pt-1', name: 'NYSC Agripreneur Pathway' },
            stagesTotal: 4,
            stagesCompleted: 1,
            currentStageTitle: 'Demo plot'
          }
        ]
      },
      '/opportunities': { data: [{ id: 'opp-1' }], total: 7, page: 1, pageSize: 1 },
      '/advisory/weather/Kano': {
        data: {
          state: 'Kano',
          temperatureCelsius: 31,
          humidityPercent: 42,
          rainfallMm: 3,
          outlook: 'Dry and sunny',
          source: 'stub'
        }
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

    expect(text).toContain('Training progress');
    expect(text).toContain('25%');
    expect(text).toContain('1 of 4 stages complete');
    expect(text).toContain('Opportunities');
    expect(text).toContain('7');
    expect(text).toContain('Weather — Kano');
    expect(text).toContain('31°C');
    expect(text).toContain('Dry and sunny');
  });
});
