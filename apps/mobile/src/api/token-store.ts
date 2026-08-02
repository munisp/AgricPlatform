/**
 * Session persistence for the API client (Wave A: refresh-token sessions).
 *
 * Production builds back this interface with `expo-secure-store`
 * (Keychain / Keystore). The in-memory implementation below is the
 * documented fallback for tests, the Expo web preview, and CI — it never
 * touches the filesystem or native modules.
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
