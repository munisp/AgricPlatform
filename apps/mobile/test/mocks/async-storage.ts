/**
 * In-memory mock of @react-native-async-storage/async-storage for vitest.
 * Behaves like the real module (async, string-only values) so durable
 * storage tests exercise the same code paths as the device build. State is
 * shared per test file — clear it between tests with __clear().
 */
const map = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return map.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    map.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    map.delete(key);
  },
  async getAllKeys(): Promise<string[]> {
    return [...map.keys()];
  },
  async clear(): Promise<void> {
    map.clear();
  }
};

export function __clear(): void {
  map.clear();
}

export default AsyncStorage;
