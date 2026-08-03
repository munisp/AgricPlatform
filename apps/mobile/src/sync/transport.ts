/**
 * Binds the sync store's transport to the real ApiClient via the
 * /sync endpoint helpers (Wave SYNCSRV contract, docs/sync-protocol.md).
 * Kept separate from store.ts so tests can stub the transport without an
 * HTTP layer — or stub the ApiClient and exercise this adapter.
 */

import type { ApiClient } from '../api/client';
import { syncPull, syncPush, syncStatus } from '../api/endpoints';
import type { SyncTransport } from './store';

export function createApiSyncTransport(client: ApiClient): SyncTransport {
  return {
    push: async (items) => {
      const res = await syncPush(client, items);
      return res.data;
    },
    pull: async (params) => {
      const res = await syncPull(client, params);
      return res.data;
    },
    status: async () => {
      const res = await syncStatus(client);
      return res.data;
    }
  };
}
