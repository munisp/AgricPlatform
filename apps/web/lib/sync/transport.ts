/**
 * Binds the sync store's transport to the app's API client via the /sync
 * endpoint helpers (Wave SYNCSRV contract, docs/sync-protocol.md). Tests
 * can stub the transport directly, or stub fetch and exercise this adapter.
 */

import { syncPull, syncPush, syncStatus } from '@/lib/api/endpoints';
import type { SyncTransport } from './store';

export function createApiSyncTransport(): SyncTransport {
  return {
    push: async (items) => {
      const res = await syncPush(items);
      return res.data;
    },
    pull: async (params) => {
      const res = await syncPull(params);
      return res.data;
    },
    status: async () => {
      const res = await syncStatus();
      return res.data;
    }
  };
}
