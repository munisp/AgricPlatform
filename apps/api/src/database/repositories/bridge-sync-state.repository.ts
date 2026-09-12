/**
 * Bridge sync-state port (WP-G20) over integrations.bridge_sync_state
 * (migration 063). One row per bridge records the last scheduled sync
 * outcome so ops can see when Moodle/Discourse/Directus last synced, why a
 * run was skipped, and whether the fetched payload changed.
 */

export type BridgeName = 'moodle' | 'discourse' | 'directus';

export type BridgeSyncStatus = 'never' | 'ok' | 'failed' | 'skipped';

export interface BridgeSyncState {
  bridge: BridgeName;
  /** ISO timestamp of the last SUCCESSFUL sync; absent until the first ok. */
  lastSyncedAt?: string;
  lastStatus: BridgeSyncStatus;
  /** sha256 of the fetched payload (change detection across runs). */
  payloadHash?: string;
  /** Short ops-readable reason for failed/skipped outcomes. */
  detail?: string;
}

export interface BridgeSyncStateRepository {
  get(bridge: BridgeName): Promise<BridgeSyncState | undefined>;
  upsert(state: BridgeSyncState): Promise<BridgeSyncState>;
  all(): Promise<BridgeSyncState[]>;
}

export class InMemoryBridgeSyncStateRepository implements BridgeSyncStateRepository {
  private readonly items = new Map<BridgeName, BridgeSyncState>();

  async get(bridge: BridgeName): Promise<BridgeSyncState | undefined> {
    const state = this.items.get(bridge);
    return state ? structuredClone(state) : undefined;
  }

  async upsert(state: BridgeSyncState): Promise<BridgeSyncState> {
    this.items.set(state.bridge, structuredClone(state));
    return state;
  }

  async all(): Promise<BridgeSyncState[]> {
    return [...this.items.values()].map((state) => structuredClone(state));
  }
}

export function createInMemoryBridgeSyncStateRepository(): InMemoryBridgeSyncStateRepository {
  return new InMemoryBridgeSyncStateRepository();
}
