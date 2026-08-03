/**
 * Session persistence for the API client (Wave A: refresh-token sessions).
 *
 * Production builds back this interface with `expo-secure-store`
 * (Keychain / Keystore) via createSecureStoreTokenStore below. The
 * in-memory implementation is the documented fallback for tests, the Expo
 * web preview, and CI — it never touches the filesystem or native modules.
 *
 * SECURITY: tokens must NEVER silently fall back to plaintext storage
 * (AsyncStorage) when the secure store fails — failures are surfaced as
 * TokenStorageError so the app can show a clear error state (fail-closed).
 *
 * Both halves of the session live here: the short-lived bearer access token
 * and the long-lived refresh token minted at login (POST /auth/otp/verify).
 * The client rotates the refresh token via POST /auth/refresh on a 401 and
 * revokes it via POST /auth/logout on sign-out; `clear()` always wipes both.
 */
export interface TokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  /** Persist both halves of a fresh session (login / rotation). */
  setSession(session: { token?: string; refreshToken: string }): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory TokenStore fallback (see module note). */
export function createInMemoryTokenStore(): TokenStore {
  let token: string | null = null;
  let refreshToken: string | null = null;
  return {
    async getToken() {
      return token;
    },
    async setToken(next: string) {
      token = next;
    },
    async getRefreshToken() {
      return refreshToken;
    },
    async setRefreshToken(next: string) {
      refreshToken = next;
    },
    async setSession(session: { token?: string; refreshToken: string }) {
      if (session.token !== undefined) token = session.token;
      refreshToken = session.refreshToken;
    },
    async clear() {
      token = null;
      refreshToken = null;
    }
  };
}

/* ------------------------- expo-secure-store adapter -------------------- */

/** Minimal surface of expo-secure-store this adapter needs (injectable). */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * Raised when the device secure store (Keychain / Keystore) cannot be read
 * or written. The app treats this as fatal for session handling — it shows
 * an honest error state instead of degrading to plaintext storage.
 */
export class TokenStorageError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TokenStorageError';
  }
}

const ACCESS_TOKEN_KEY = 'nyfn.session.access-token.v1';
const REFRESH_TOKEN_KEY = 'nyfn.session.refresh-token.v1';

/**
 * Durable TokenStore backed by expo-secure-store (iOS Keychain / Android
 * Keystore). Tokens survive app restarts; both halves are wiped on clear().
 *
 * Fail-closed: any secure-store failure rejects with TokenStorageError —
 * reads do NOT quietly return null (which would silently log the user out
 * or, worse, tempt a plaintext fallback).
 */
export function createSecureStoreTokenStore(store: SecureStoreLike): TokenStore {
  async function read(key: string): Promise<string | null> {
    try {
      return await store.getItemAsync(key);
    } catch (error) {
      throw new TokenStorageError(
        'Could not read the device secure store — your session cannot be restored safely',
        error
      );
    }
  }
  async function write(key: string, value: string): Promise<void> {
    try {
      await store.setItemAsync(key, value);
    } catch (error) {
      throw new TokenStorageError(
        'Could not write to the device secure store — sign-in cannot be completed safely',
        error
      );
    }
  }
  async function remove(key: string): Promise<void> {
    try {
      await store.deleteItemAsync(key);
    } catch (error) {
      throw new TokenStorageError('Could not clear the device secure store', error);
    }
  }

  return {
    getToken: () => read(ACCESS_TOKEN_KEY),
    setToken: (token: string) => write(ACCESS_TOKEN_KEY, token),
    getRefreshToken: () => read(REFRESH_TOKEN_KEY),
    setRefreshToken: (token: string) => write(REFRESH_TOKEN_KEY, token),
    async setSession(session: { token?: string; refreshToken: string }) {
      if (session.token !== undefined) await write(ACCESS_TOKEN_KEY, session.token);
      await write(REFRESH_TOKEN_KEY, session.refreshToken);
    },
    async clear() {
      await remove(ACCESS_TOKEN_KEY);
      await remove(REFRESH_TOKEN_KEY);
    }
  };
}
