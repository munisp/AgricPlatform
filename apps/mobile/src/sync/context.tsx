import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useApiClient } from '../api/context';
import { createInMemoryStorage } from '../offline/queue';
import { createSyncStore, type SyncStore, type SyncStoreStatus } from './store';
import { createApiSyncTransport } from './transport';

/**
 * React wiring for the record-level sync store.
 *
 * App.tsx mounts one <SyncProvider> so every screen shares a single store
 * (consistent pending/conflict counts). Screens may also call useSyncStore()
 * WITHOUT a provider — they get an ad-hoc in-memory store bound to the
 * ambient ApiClient, which keeps older tests and previews working.
 *
 * Persistence: App.tsx passes the AsyncStorage adapter as `storage`, so
 * cursors/outbox/conflict-log survive restarts (audit P0-4). The in-memory
 * KeyValueStorage remains the default for tests and previews rendered
 * without the full app shell.
 */

const SyncContext = createContext<SyncStore | null>(null);

export function SyncProvider({
  store,
  storage,
  children
}: {
  /** Pre-built store (tests); wins over `storage`. */
  store?: SyncStore;
  /** Persistence backend; defaults to in-memory (see module note). */
  storage?: Parameters<typeof createSyncStore>[0]['storage'];
  children: ReactNode;
}) {
  const client = useApiClient();
  const resolved = useMemo(
    () => store ?? createSyncStore({
      storage: storage ?? createInMemoryStorage(),
      transport: createApiSyncTransport(client)
    }),
    [store, storage, client]
  );
  return <SyncContext.Provider value={resolved}>{children}</SyncContext.Provider>;
}

export function useSyncStore(): SyncStore {
  const client = useApiClient();
  const provided = useContext(SyncContext);
  const fallback = useMemo(
    () => createSyncStore({
      storage: createInMemoryStorage(),
      transport: createApiSyncTransport(client)
    }),
    [client]
  );
  return provided ?? fallback;
}

/** Live status snapshot (pending/conflicts/lastSync) for indicators. */
export function useSyncStatus(store?: SyncStore): SyncStoreStatus {
  const resolved = store ?? useSyncStore();
  return useSyncExternalStore(resolved.subscribe, resolved.getStatus, resolved.getStatus);
}
