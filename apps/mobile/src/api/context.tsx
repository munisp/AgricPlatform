import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client';

/**
 * Provides the shared ApiClient to screens. Tests inject a client backed by
 * a stub fetch; the app wires one built from src/config.ts + a TokenStore.
 */
const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) {
    throw new Error('useApiClient must be used inside <ApiProvider>');
  }
  return client;
}
