/**
 * In-memory mock of expo-secure-store for vitest. The mock can be put into
 * a failing state with __failWith() to verify fail-closed behaviour. State
 * is shared per test file — clear it between tests with __reset().
 */
const map = new Map<string, string>();
let failure: Error | null = null;

function maybeFail(): void {
  if (failure) throw failure;
}

export async function getItemAsync(key: string): Promise<string | null> {
  maybeFail();
  return map.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  maybeFail();
  map.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  maybeFail();
  map.delete(key);
}

export async function isAvailableAsync(): Promise<boolean> {
  return failure === null;
}

/** Put the mock into a failing state (or pass null to recover). */
export function __failWith(error: Error | null): void {
  failure = error;
}

export function __reset(): void {
  map.clear();
  failure = null;
}
