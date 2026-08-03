/**
 * App-level tests (audit P0-1/P0-4/P1-7): these MOUNT App.tsx itself — the
 * auth dead-end survived precisely because no test did. React Navigation,
 * expo-secure-store, AsyncStorage, NetInfo and friends are aliased to
 * in-memory mocks (vitest.config.ts); the network is a stubbed fetch.
 */
import { act, type ReactNode } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import App from '../App';

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

const USER = {
  id: 'user-1',
  phone: '+2348012345678',
  fullName: 'Test Farmer',
  roles: ['farmer'],
  preferredLanguage: 'en'
};

/** 'ok' serves the happy-path API; 'expired' 401s everything (incl. refresh). */
let apiMode: 'ok' | 'expired' = 'ok';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function stubFetch(): void {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;

    if (apiMode === 'expired') {
      return jsonResponse({ message: 'session expired' }, 401);
    }
    if (path.endsWith('/auth/otp/request')) {
      return jsonResponse({ data: { requestId: 'req-1' } });
    }
    if (path.endsWith('/auth/otp/verify')) {
      return jsonResponse({
        data: { token: 'at-1', refreshToken: 'rt-1', user: USER }
      });
    }
    if (path.endsWith('/auth/refresh')) {
      return jsonResponse({
        data: { token: 'at-2', refreshToken: 'rt-2', user: USER }
      });
    }
    if (path.endsWith('/auth/session')) {
      // No access token (e.g. cold start with only a refresh token) → 401,
      // which drives the client's transparent rotation + retry.
      if (!auth) return jsonResponse({ message: 'missing token' }, 401);
      return jsonResponse({ data: { user: USER } });
    }
    if (path.endsWith('/opportunities')) {
      return jsonResponse({ data: [], total: 0, page: 1, pageSize: 1 });
    }
    if (path.includes('/advisory/weather')) {
      return jsonResponse({ message: 'no weather' }, 404); // best-effort card
    }
    return jsonResponse({ data: [] });
  }) as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
}

async function mountApp(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<App />);
  });
  await flush();
  return renderer!;
}

async function loginViaOtp(renderer: ReactTestRenderer): Promise<void> {
  await interact(() => setInputAt(renderer.root, 0, '+2348012345678'));
  await interact(() => pressByLabel(renderer.root, 'Send code'));
  await interact(() => setInputAt(renderer.root, 1, '123456'));
  await interact(() => pressByLabel(renderer.root, 'Verify and sign in'));
}

/* -------------------------------- tests --------------------------------- */

describe('App (mounted)', () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    apiMode = 'ok';
    (SecureStore as unknown as { __reset: () => void }).__reset();
    void AsyncStorage.clear();
    stubFetch();
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer!.unmount();
      });
      renderer = undefined;
    }
    vi.unstubAllGlobals();
  });

  it('starts on the Login screen when there is no stored session (P0-1)', async () => {
    renderer = await mountApp();
    const text = screenText(renderer.root);
    expect(text).toContain('Welcome to NYFN');
    expect(text).not.toContain('Training progress');
  });

  it('switches to the app screens after OTP login — no dead end (P0-1)', async () => {
    renderer = await mountApp();
    await loginViaOtp(renderer);

    const text = screenText(renderer.root);
    expect(text).not.toContain('Welcome to NYFN');
    expect(text).toContain('Training progress');
    // Session persisted to the secure store.
    expect(await SecureStore.getItemAsync('nyfn.session.refresh-token.v1')).toBe('rt-1');
  });

  it('returns to Login when the session expires unrecoverably (P1-7)', async () => {
    renderer = await mountApp();
    await loginViaOtp(renderer);
    expect(screenText(renderer.root)).toContain('Training progress');

    // The session family dies server-side: every call 401s and the refresh
    // rotation is rejected, so the client's onSessionExpired must drop the
    // user and the navigator must land back on Login.
    apiMode = 'expired';
    await interact(() => pressByLabel(renderer!.root, 'My plots'));
    await flush();

    expect(screenText(renderer.root)).toContain('Welcome to NYFN');
    // The dead session was cleared from the secure store.
    expect(await SecureStore.getItemAsync('nyfn.session.refresh-token.v1')).toBeNull();
  });

  it('restores a persisted session on cold start (P0-4)', async () => {
    // Simulate a previous run: only the long-lived refresh token survives.
    await SecureStore.setItemAsync('nyfn.session.refresh-token.v1', 'rt-old');

    renderer = await mountApp();
    const text = screenText(renderer.root);
    // Skips Login entirely: refresh rotation → session fetch → Home.
    expect(text).toContain('Training progress');
    expect(text).not.toContain('Welcome to NYFN');
    // Rotated tokens were persisted.
    expect(await SecureStore.getItemAsync('nyfn.session.refresh-token.v1')).toBe('rt-2');
  });

  it('fails closed with a clear error when the secure store is broken (P0-4)', async () => {
    (SecureStore as unknown as { __failWith: (e: Error | null) => void }).__failWith(
      new Error('keystore locked')
    );

    renderer = await mountApp();
    let text = screenText(renderer.root);
    expect(text).toContain('Secure storage unavailable');
    expect(text).not.toContain('Welcome to NYFN');

    // Recovering the secure store + retry returns to the normal flow.
    (SecureStore as unknown as { __failWith: (e: Error | null) => void }).__failWith(null);
    await interact(() => pressByLabel(renderer!.root, 'Try again'));
    text = screenText(renderer.root);
    expect(text).toContain('Welcome to NYFN');
  });

  it('signs out back to the Login screen via Profile (P0-1)', async () => {
    renderer = await mountApp();
    await loginViaOtp(renderer);

    await interact(() => pressByLabel(renderer!.root, 'View profile'));
    await interact(() => pressByLabel(renderer!.root, 'Sign out'));

    expect(screenText(renderer.root)).toContain('Welcome to NYFN');
  });
});

/* Silence unused-import warning for the helper type in CI lint configs. */
export type { ReactNode };
