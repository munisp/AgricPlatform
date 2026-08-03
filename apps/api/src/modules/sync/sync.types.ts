/**
 * Sync protocol v1 wire types (Wave SYNCSRV). The authoritative contract for
 * the client wave is docs/sync-protocol.md; these types mirror it exactly.
 */

/** Operations a client may push. `upsert` creates or replaces; `delete` tombstones. */
export type SyncPushOp = 'upsert' | 'delete';

export interface SyncPushItem {
  /** Registered sync entity name (see SyncEntityRegistry). */
  entity: string;
  /** Client-stable record id (text). */
  entityId: string;
  /** Unique per (user, mutation); replays return the original outcome. */
  clientMutationId: string;
  /** Version the client based its change on (0 = expected new record). */
  baseVersion: number;
  op: SyncPushOp;
  /** Replacement payload for upsert (omitted for delete). */
  payload?: Record<string, unknown>;
}

export type SyncPushItemStatus = 'applied' | 'conflict' | 'error';

export interface SyncPushItemResult {
  entity: string;
  entityId: string;
  clientMutationId: string;
  status: SyncPushItemStatus;
  /** Set when status = 'applied'. */
  newVersion?: number;
  /** Set when status = 'conflict': the version currently on the server. */
  serverVersion?: number;
  /** Set when status = 'conflict': the server's current payload (server-wins). */
  serverPayload?: unknown;
  /** Set when status = 'error': machine-readable reason code. */
  error?: string;
}

export interface SyncPullItem {
  entityId: string;
  version: number;
  deleted: boolean;
  /** Current server payload; null for tombstones. */
  payload: unknown;
}

export interface SyncPullPage {
  entity: string;
  items: SyncPullItem[];
  /** Monotonic per (user, entity): pass back as `since` on the next pull. */
  cursor: number;
  /** True when more rows are visible beyond this page. */
  hasMore: boolean;
}

export interface SyncStatusEntry {
  entity: string;
  /** Highest version currently visible in the caller's scope. */
  serverMaxVersion: number;
  /** Last cursor the server recorded for the caller (0 when never pulled). */
  cursor: number;
}

/** Hard protocol limits (fail-closed; enforced before any item is processed). */
export const SYNC_PUSH_BATCH_LIMIT = 200;
export const SYNC_PUSH_PAYLOAD_MAX_BYTES = 64 * 1024;
export const SYNC_PULL_LIMIT_DEFAULT = 200;
export const SYNC_PULL_LIMIT_MAX = 500;
export const SYNC_CLIENT_MUTATION_ID_MAX_LENGTH = 128;
export const SYNC_ENTITY_ID_MAX_LENGTH = 128;
