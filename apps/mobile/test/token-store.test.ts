import { describe, expect, it } from 'vitest';
import { createInMemoryTokenStore } from '../src/api/token-store';

describe('in-memory token store (secure-store adapter fallback)', () => {
  it('stores, returns and clears the bearer token', async () => {
    const store = createInMemoryTokenStore();
    expect(await store.getToken()).toBeNull();
    await store.setToken('stub-token.xyz');
    expect(await store.getToken()).toBe('stub-token.xyz');
    await store.clear();
    expect(await store.getToken()).toBeNull();
  });
});
