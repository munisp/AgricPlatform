/**
 * Bearer-token persistence for the API client.
 *
 * Production builds back this interface with `expo-secure-store`
 * (Keychain / Keystore). The in-memory implementation below is the
 * documented fallback for tests, the Expo web preview, and CI — it never
 * touches the filesystem or native modules.
 */
export interface TokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory TokenStore fallback (see module note). */
export function createInMemoryTokenStore(): TokenStore {
  let token: string | null = null;
  return {
    async getToken() {
      return token;
    },
    async setToken(next: string) {
      token = next;
    },
    async clear() {
      token = null;
    }
  };
}
