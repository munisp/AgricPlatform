'use client';

/**
 * Shared web sync-store instance + React bindings.
 *
 * A single module-level store keeps pending/conflict counts consistent
 * across components (bell, dashboard). Persistence follows the existing web
 * offline patterns (localStorage with in-memory degradation). Syncs are
 * invoked EXPLICITLY (syncNow from screens/user actions) — no background
 * timers here; the transport-level queue in lib/app-state.tsx already owns
 * interval/online flushing and stays untouched.
 */

import { useSyncExternalStore } from 'react';
import { createSyncStore, type SyncStore, type SyncStoreStatus } from './store';
import { createWebSyncStorage } from './storage';
import { createApiSyncTransport } from './transport';

/**
 * Entities the web app syncs today (read-only proof entities, protocol §2).
 * `marketplace_listing` was removed: no web screen reads synced listing
 * records — marketplace screens query the API directly (with fixtures).
 */
export const WEB_SYNC_ENTITIES = ['notification'] as const;

let shared: SyncStore | null = null;

export function getSharedSyncStore(): SyncStore {
  shared ??= createSyncStore({
    storage: createWebSyncStorage(),
    transport: createApiSyncTransport()
  });
  return shared;
}

/** Test hook: replace the shared instance (e.g. with a stubbed transport). */
export function setSharedSyncStore(store: SyncStore | null): void {
  shared = store;
}

export function useSyncStatus(store?: SyncStore): SyncStoreStatus {
  const resolved = store ?? getSharedSyncStore();
  return useSyncExternalStore(resolved.subscribe, resolved.getStatus, resolved.getStatus);
}
