/**
 * Sync protocol v2 wire types (Wave SYNCSRV + FP-4). The authoritative
 * contract for the client wave is docs/sync-protocol.md; these types mirror
 * it exactly.
 *
 * v2: pull cursors operate on the GLOBAL monotonic `change_seq` (per-record
 * `version` remains the push CAS counter only). Pulls with a non-zero
 * `since` MUST declare `v=2`; legacy (v1) cursors are rejected with a 409
 * `sync_resync_required` signal so pre-v2 devices fail loudly and resync
 * instead of silently diverging.
 */

/** Current protocol version. Clients pass it as `v` on pull. */
export const SYNC_PROTOCOL_VERSION = 2;

/** Machine-readable resync signal (409 body `error` / message prefix). */
export const SYNC_RESYNC_REQUIRED_CODE = 'sync_resync_required';
export const SYNC_RESYNC_REQUIRED_MESSAGE =
  'resync_required: the pull cursor predates sync protocol v2 — reset to since=0 and perform a full sync';

/**
 * Thrown by entity apply hooks when the atomic version-row claim is lost to
 * a concurrent writer (V-18). The sync engine maps it to a per-item
 * `conflict` result carrying the fresh server version + payload — never a
 * retryable `apply_failed`, and the losing payload never lands.
 */
export class SyncVersionConflictError extends Error {
  override readonly name = 'SyncVersionConflictError';
  constructor(entity: string, entityId: string) {
    super(`sync version claim lost for ${entity}/${entityId}`);
  }
}

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
  /** Per-record version — push baseVersion bookkeeping only, NOT a cursor. */
  version: number;
  /** Global monotonic change sequence this state was stamped with (v2). */
  changeSeq: number;
  deleted: boolean;
  /** Current server payload; null for tombstones. */
  payload: unknown;
}

export interface SyncPullPage {
  entity: string;
  items: SyncPullItem[];
  /**
   * change_seq cursor: monotonic per (user, entity); pass back as `since`
   * (with `v=2`) on the next pull.
   */
  cursor: number;
  /** True when more rows are visible beyond this page. */
  hasMore: boolean;
  /** Protocol version that minted this page's cursor (2). */
  protocol: number;
}

export interface SyncStatusEntry {
  entity: string;
  /**
   * Highest change_seq currently visible in the caller's scope (0 when
   * nothing visible). Kept under the v1 field name for wire compatibility —
   * comparable against v2 cursors only.
   */
  serverMaxVersion: number;
  /**
   * Last v2 cursor the server recorded for the caller (0 when never pulled
   * under v2; stale v1 records are not surfaced).
   */
  cursor: number;
}

/** Hard protocol limits (fail-closed; enforced before any item is processed). */
export const SYNC_PUSH_BATCH_LIMIT = 200;
export const SYNC_PUSH_PAYLOAD_MAX_BYTES = 64 * 1024;
export const SYNC_PULL_LIMIT_DEFAULT = 200;
export const SYNC_PULL_LIMIT_MAX = 500;
export const SYNC_CLIENT_MUTATION_ID_MAX_LENGTH = 128;
export const SYNC_ENTITY_ID_MAX_LENGTH = 128;
