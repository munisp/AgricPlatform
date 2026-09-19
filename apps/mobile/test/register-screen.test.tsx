import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { createInMemoryTokenStore, type TokenStore } from '../src/api/token-store';
import { RegisterScreen } from '../src/screens/RegisterScreen';

/* ------------------------------ helpers --------------------------------- */
/* Same react-test-renderer harness as test/screens.test.tsx. */

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

/* ---------------------------- register ---------------------------------- */

describe('RegisterScreen (OB-18)', () => {
  it('offers only self-registration roles — no privileged options', async () => {
    const api = stubApi({});
    const renderer = await renderWithApi(
      api,
      <RegisterScreen tokenStore={api.tokenStore} onRegistered={() => {}} />
    );
    const text = screenText(renderer.root);
    expect(text).toContain('Create your account');
    for (const role of ['Farmer', 'Student', 'Buyer', 'Supplier']) {
      expect(text).toContain(role);
    }
    // Privileged roles must not be selectable (the API would 400 them).
    for (const privileged of ['Admin', 'Partner', 'Enumerator', 'Agent', 'Lender']) {
      expect(text).not.toContain(privileged);
    }
  });

  it('registers, then verifies the OTP from the returned otpRequestId (OB-01 contract)', async () => {
    const api = stubApi({
      '/auth/register': {
        data: {
          user: {
            id: 'user-new',
            phone: '+2348010000007',
            fullName: 'New Farmer',
            roles: ['farmer'],
            preferredLanguage: 'en'
          },
          otpRequestId: 'req-reg-1'
        }
      },
      '/auth/otp/verify': {
        data: {
          token: 'stub-token.reg',
          refreshToken: 'stub-refresh.reg',
          user: {
            id: 'user-new',
            phone: '+2348010000007',
            fullName: 'New Farmer',
            roles: ['farmer'],
            preferredLanguage: 'en'
          }
        }
      }
    });
    const onRegistered = vi.fn();
    const renderer = await renderWithApi(
      api,
      <RegisterScreen tokenStore={api.tokenStore} onRegistered={onRegistered} />
    );
    const root = renderer.root;

    await interact(() => inputByLabel(root, 'Full name').props.onChangeText('New Farmer'));
    await interact(() =>
      inputByLabel(root, 'Phone number').props.onChangeText('+2348010000007')
    );
    await interact(() => pressByLabel(root, 'Register'));

    // Registration posted with a self-registration role only…
    const registerCall = api.calls.find((call) => call.url.endsWith('/auth/register'));
    expect(registerCall).toBeTruthy();
    const body = JSON.parse(String(registerCall!.init?.body)) as {
      phone: string;
      fullName: string;
      roles: string[];
      preferredLanguage: string;
    };
    expect(body).toMatchObject({
      phone: '+2348010000007',
      fullName: 'New Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });

    // …and the OTP step appears WITHOUT a session having been issued.
    expect(await api.tokenStore.getToken()).toBeNull();
    await interact(() => inputByLabel(root, 'One-time code').props.onChangeText('123456'));
    await interact(() => pressByLabel(root, 'Verify and sign in'));

    // Verification used the otpRequestId from the register response.
    const verifyCall = api.calls.find((call) => call.url.endsWith('/auth/otp/verify'));
    expect(verifyCall).toBeTruthy();
    expect(JSON.parse(String(verifyCall!.init?.body))).toMatchObject({
      requestId: 'req-reg-1',
      code: '123456'
    });
    expect(await api.tokenStore.getToken()).toBe('stub-token.reg');
    expect(onRegistered).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-new' }));
  });

  it('shows the API error and issues no session when registration is rejected', async () => {
    const api = stubApi({}); // no route stubbed → 404 envelope
    const onRegistered = vi.fn();
    const renderer = await renderWithApi(
      api,
      <RegisterScreen tokenStore={api.tokenStore} onRegistered={onRegistered} />
    );
    const root = renderer.root;

    await interact(() => inputByLabel(root, 'Full name').props.onChangeText('New Farmer'));
    await interact(() =>
      inputByLabel(root, 'Phone number').props.onChangeText('+2348010000007')
    );
    await interact(() => pressByLabel(root, 'Register'));

    expect(await api.tokenStore.getToken()).toBeNull();
    expect(onRegistered).not.toHaveBeenCalled();
    // The OTP step must not appear after a failed registration.
    expect(() => inputByLabel(root, 'One-time code')).toThrow();
  });
});
