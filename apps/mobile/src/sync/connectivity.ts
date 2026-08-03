import { useEffect } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useApiClient } from '../api/context';
import type { OfflineQueue } from '../offline/queue';
import { useSyncStore } from './context';

/**
 * Connectivity-driven sync (audit P1-12).
 *
 * Behaviour contract (documented for store review + users):
 * - On REGAINING connectivity (offline → online): the legacy offline
 *   mutation queue is flushed immediately so field work (agent progress)
 *   reaches the server as soon as possible, together with the record-level
 *   sync outbox (plot captures, W-SYNCWRITE); then the sync store pulls the
 *   latest server state.
 * - On returning to FOREGROUND: the same flush + pull runs, so data seen
 *   after switching apps is fresh.
 * - METERED CONNECTIONS (NetInfo `details.isConnectionExpensive`): both
 *   outbox flushes still run — those are the user's own queued writes and
 *   delaying them risks data loss — but background PULLS are skipped to
 *   conserve mobile data. Pulls still happen on unmetered connections and
 *   whenever a screen explicitly syncs.
 * - Sync failures are never fatal here: the queue/store keep their state
 *   and the next trigger retries.
 */

export interface ConnectivityStateLike {
  isConnected?: boolean | null;
  details?: { isConnectionExpensive?: boolean } | null;
}

export interface ConnectivitySyncDeps {
  addNetInfoListener: (listener: (state: ConnectivityStateLike) => void) => () => void;
  addAppStateListener: (listener: (state: string) => void) => () => void;
  /** Replay pending offline mutations. */
  flushOutbox: () => Promise<unknown>;
  /** Pull latest server state into the sync store. */
  pullLatest: () => Promise<unknown>;
}

/** Pure wiring — fully testable without React or native modules. */
export function startConnectivitySync(deps: ConnectivitySyncDeps): () => void {
  let lastMetered = false;

  const run = (metered: boolean): void => {
    lastMetered = metered;
    void deps.flushOutbox().catch(() => undefined);
    if (!metered) {
      void deps.pullLatest().catch(() => undefined);
    }
  };

  const offNetInfo = deps.addNetInfoListener((state) => {
    const metered = Boolean(state.details?.isConnectionExpensive);
    lastMetered = metered;
    if (!state.isConnected) return;
    run(metered);
  });

  const offAppState = deps.addAppStateListener((state) => {
    if (state !== 'active') return;
    run(lastMetered);
  });

  return () => {
    offNetInfo();
    offAppState();
  };
}

/**
 * React binding: flushes the shared offline queue and pulls the sync
 * entities on reconnect/foreground (see module note for metered rules).
 */
export function useConnectivitySync({
  queue,
  entities
}: {
  queue: OfflineQueue;
  entities: readonly string[];
}) {
  const client = useApiClient();
  const store = useSyncStore();

  useEffect(() => {
    return startConnectivitySync({
      addNetInfoListener: (listener) => NetInfo.addEventListener(listener),
      addAppStateListener: (listener) => {
        const subscription = AppState.addEventListener('change', listener);
        return () => subscription.remove();
      },
      flushOutbox: async () => {
        // Legacy transport queue (agent progress reports) AND the
        // record-level sync outbox (farm_plot writes, W-SYNCWRITE) — both
        // are the user's own queued writes, so both flush on reconnect,
        // including on metered connections (see module note).
        await queue.flush((request) =>
          client.apiFetch(request.path, {
            method: request.method,
            body: request.payload,
            idempotencyKey: request.idempotencyKey
          })
        );
        await store.pushPending();
      },
      pullLatest: () => store.syncNow(entities)
    });
  }, [client, store, queue, entities]);
}
