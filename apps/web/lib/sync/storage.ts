/**
 * Storage backends for the web sync store. Mirrors the mobile
 * KeyValueStorage contract (apps/mobile/src/offline/queue.ts) so the two
 * store copies stay algorithm-identical.
 */

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** In-memory fallback (SSR, tests, storage-disabled browsers). */
export function createInMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    }
  };
}

/**
 * localStorage-backed storage, consistent with the app's existing web
 * offline patterns (lib/app-state.tsx, lib/use-persistent-state.ts):
 * guarded access, silent degradation to in-memory when unavailable.
 */
export function createWebSyncStorage(): KeyValueStorage {
  const fallback = createInMemoryStorage();
  const available = () =>
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  return {
    async getItem(key) {
      if (!available()) return fallback.getItem(key);
      try {
        return window.localStorage.getItem(key);
      } catch {
        return fallback.getItem(key);
      }
    },
    async setItem(key, value) {
      if (!available()) return fallback.setItem(key, value);
      try {
        window.localStorage.setItem(key, value);
      } catch {
        await fallback.setItem(key, value);
      }
    },
    async removeItem(key) {
      if (!available()) return fallback.removeItem(key);
      try {
        window.localStorage.removeItem(key);
      } catch {
        await fallback.removeItem(key);
      }
    }
  };
}
