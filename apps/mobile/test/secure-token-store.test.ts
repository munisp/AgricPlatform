/** SecureStore token-store adapter tests (audit P0-4): durable sessions and
 *  fail-closed behaviour — never a plaintext fallback. */
import { beforeEach, describe, expect, it } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import {
  createSecureStoreTokenStore,
  TokenStorageError
} from '../src/api/token-store';

const mock = SecureStore as unknown as {
  __reset: () => void;
  __failWith: (error: Error | null) => void;
};

describe('createSecureStoreTokenStore', () => {
  beforeEach(() => mock.__reset());

  it('persists both halves of a session and reads them back', async () => {
    const store = createSecureStoreTokenStore(SecureStore);
    await store.setSession({ token: 'at-1', refreshToken: 'rt-1' });
    expect(await store.getToken()).toBe('at-1');
    expect(await store.getRefreshToken()).toBe('rt-1');
  });

  it('survives re-instantiation (app restart) because storage is durable', async () => {
    await createSecureStoreTokenStore(SecureStore).setSession({
      token: 'at-1',
      refreshToken: 'rt-1'
    });
    const afterRestart = createSecureStoreTokenStore(SecureStore);
    expect(await afterRestart.getToken()).toBe('at-1');
    expect(await afterRestart.getRefreshToken()).toBe('rt-1');
  });

  it('updates only the access token when setSession omits it (rotation)', async () => {
    const store = createSecureStoreTokenStore(SecureStore);
    await store.setSession({ token: 'at-1', refreshToken: 'rt-1' });
    await store.setSession({ refreshToken: 'rt-2' });
    expect(await store.getToken()).toBe('at-1');
    expect(await store.getRefreshToken()).toBe('rt-2');
  });

  it('clear() wipes both tokens', async () => {
    const store = createSecureStoreTokenStore(SecureStore);
    await store.setSession({ token: 'at-1', refreshToken: 'rt-1' });
    await store.clear();
    expect(await store.getToken()).toBeNull();
    expect(await store.getRefreshToken()).toBeNull();
  });

  it('fails closed with TokenStorageError when the secure store errors on read', async () => {
    const store = createSecureStoreTokenStore(SecureStore);
    await store.setSession({ token: 'at-1', refreshToken: 'rt-1' });
    mock.__failWith(new Error('keystore locked'));
    // A failed read must NOT silently return null (which would look like
    // "logged out" and tempt a plaintext fallback).
    await expect(store.getRefreshToken()).rejects.toBeInstanceOf(TokenStorageError);
    await expect(store.getToken()).rejects.toBeInstanceOf(TokenStorageError);
  });

  it('fails closed with TokenStorageError when the secure store errors on write', async () => {
    mock.__failWith(new Error('keystore full'));
    const store = createSecureStoreTokenStore(SecureStore);
    await expect(
      store.setSession({ token: 'at-1', refreshToken: 'rt-1' })
    ).rejects.toBeInstanceOf(TokenStorageError);
    // Nothing was persisted.
    mock.__failWith(null);
    expect(await store.getToken()).toBeNull();
  });
});
