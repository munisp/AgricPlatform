/**
 * Record-level offline sync store (Wave SYNCCLIENT) — client side of the
 * sync protocol v1 contract in docs/sync-protocol.md.
 *
 * Entity-agnostic: any entity key registered server-side can be pulled into
 * the local cache, and any local mutation can be outboxed for push. The v1
 * proof entities (marketplace_listing, notification) are read-only
 * server-side, but the push machinery is fully implemented for the writable
 * entities arriving with later waves.
 *
 * Semantics (per the contract):
 * - Pull pages since a per-entity cursor, applies records + tombstones in
 *   version order, and advances the cursor monotonically (never regresses,
 *   even across empty pages).
 * - Tombstones (`deleted: true`) purge the local payload but KEEP the
 *   version so future `baseVersion` bookkeeping stays correct.
 * - Local mutations go to a persistent FIFO outbox with a stable
 *   clientMutationId (deduped on enqueue — retries are free, §5).
 * - Push replays the outbox in batches of ≤200 items. Per item:
 *   `applied` → confirm locally with the new version; `conflict` →
 *   SERVER-WINS (v1): adopt serverVersion + serverPayload, drop the local
 *   change and append a conflict-log entry; permanent `error` codes
 *   (unknown_entity / read_only_entity / forbidden / mutation_id_reused)
 *   drop the mutation; transient codes (apply_failed / replay_unavailable)
 *   stay queued for the next attempt.
 * - Transport failures never destroy local state: a failed pull leaves the
 *   cache intact, a failed push leaves the outbox intact.
 * - Reads merge the server-confirmed cache with an optimistic overlay of
 *   outbox mutations, so a pull can never make a pending local change
 *   vanish from the UI before the server rules on it.
 *
 * This store sits ABOVE the existing transport-level offline queue
 * (src/offline/queue.ts), which stays untouched: the queue replays whole
 * API requests, this store syncs individual records.
 *
 * The web app carries an intentionally duplicated copy of this algorithm
 * (apps/web/lib/sync/store.ts) — the two apps have separate storage and
 * transport layers and the repo has no shared client package. Keep
 * behavioural changes in sync between the two copies.
 */

import type { KeyValueStorage } from '../offline/queue';

/* ------------------------------ protocol types -------------------------- */

export type SyncOp = 'upsert' | 'delete';

export interface SyncPushRequestItem {
  entity: string;
  entityId: string;
  clientMutationId: string;
  baseVersion: number;
  op: SyncOp;
  payload?: Record<string, unknown>;
}

export interface SyncPushResultItem {
  entity: string;
  entityId: string;
  clientMutationId: string;
  status: 'applied' | 'conflict' | 'error';
  newVersion?: number;
  serverVersion?: number;
  serverPayload?: unknown;
  error?: string;
}

export interface SyncPullItem {
  entityId: string;
  version: number;
  deleted: boolean;
  payload: unknown;
}

export interface SyncPullPage {
  entity: string;
  items: SyncPullItem[];
  cursor: number;
  hasMore: boolean;
}

export interface SyncStatusEntry {
  entity: string;
  serverMaxVersion: number;
  cursor: number;
}

/**
 * Transport abstraction over the /sync endpoints. The app binds this to the
 * real ApiClient (see transport.ts); tests stub it directly.
 */
export interface SyncTransport {
  push(items: SyncPushRequestItem[]): Promise<{ results: SyncPushResultItem[] }>;
  pull(params: { entity: string; since: number; limit: number }): Promise<SyncPullPage>;
  status(): Promise<SyncStatusEntry[]>;
}

/* ------------------------------ store types ----------------------------- */

/** Server-confirmed record state in the local cache. */
export interface SyncRecordEntry {
  entity: string;
  entityId: string;
  /** Last known server version (0 = never confirmed by the server). */
  version: number;
  /** Tombstone: payload purged, version kept for baseVersion bookkeeping. */
  deleted: boolean;
  payload: unknown;
}

export interface OutboxEntry {
  entity: string;
  entityId: string;
  clientMutationId: string;
  baseVersion: number;
  op: SyncOp;
  payload?: Record<string, unknown>;
  enqueuedAt: string;
}

export interface ConflictLogEntry {
  entity: string;
  entityId: string;
  clientMutationId: string;
  serverVersion: number;
  /** Always 'server-wins' in v1 — recorded so the UI can be honest. */
  resolution: 'server-wins';
  resolvedAt: string;
}

/** A record as read by the UI: cache state + optimistic outbox overlay. */
export interface SyncRecordView {
  entity: string;
  entityId: string;
  version: number;
  payload: unknown;
  /** True when an outbox mutation is shaping what you see. */
  pending: boolean;
}

export interface PullSummary {
  entity: string;
  pages: number;
  applied: number;
  cursor: number;
}

export interface PushSummary {
  batches: number;
  applied: number;
  conflicts: number;
  /** Permanently rejected mutations dropped from the outbox. */
  dropped: number;
  /** Transiently failed mutations kept for the next attempt. */
  retried: number;
  remaining: number;
  /** Set when the push transport itself failed (outbox untouched). */
  transportError?: string;
}

export interface SyncError {
  phase: 'pull' | 'push';
  entity?: string;
  message: string;
}

export interface SyncSummary {
  pulled: PullSummary[];
  pushed: PushSummary | null;
  errors: SyncError[];
}

/** Stable snapshot object for React (useSyncExternalStore-safe). */
export interface SyncStoreStatus {
  hydrated: boolean;
  syncing: boolean;
  pending: number;
  conflictsResolved: number;
  lastSyncAt: string | null;
  lastError: string | null;
  cursors: Record<string, number>;
}

export interface EnqueueInput {
  entity: string;
  entityId: string;
  op: SyncOp;
  payload?: Record<string, unknown>;
  /** Stable across retries of one logical mutation; generated when omitted. */
  clientMutationId?: string;
}

export interface SyncStore {
  /** Load persisted state (idempotent; also awaited lazily by async ops). */
  hydrate(): Promise<void>;
  getStatus(): SyncStoreStatus;
  subscribe(listener: () => void): () => void;
  /** Live records for an entity, newest first, outbox overlay applied. */
  getRecords(entity: string): SyncRecordView[];
  getCursor(entity: string): number;
  getOutbox(): readonly OutboxEntry[];
  getConflictLog(): readonly ConflictLogEntry[];
  /** Pull one entity to completion (throws on transport/protocol failure). */
  pullEntity(entity: string): Promise<PullSummary>;
  enqueue(input: EnqueueInput): Promise<OutboxEntry>;
  pushPending(): Promise<PushSummary>;
  /** Explicit sync pass: pull every entity, then flush the outbox. */
  syncNow(entities: readonly string[]): Promise<SyncSummary>;
  /** Cheap "am I behind?" probe straight from the server (§8). */
  fetchServerStatus(): Promise<SyncStatusEntry[]>;
}

export interface SyncStoreOptions {
  storage: KeyValueStorage;
  transport: SyncTransport;
  /** Pull page size (server default 200, max 500). */
  pullLimit?: number;
  now?: () => Date;
  /** clientMutationId generator (deterministic in tests). */
  mutationId?: () => string;
}

/* ------------------------------ constants ------------------------------- */

export const SYNC_STORAGE_KEY = 'nyfn.sync-store.v1';
/** Protocol §11: push batches carry 1–200 items. */
export const PUSH_BATCH_SIZE = 200;
/** Protocol §11: per-item payload ceiling is 64 KiB of JSON. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Protocol §11 field-length limits. */
export const MAX_ENTITY_KEY_LENGTH = 64;
export const MAX_ENTITY_ID_LENGTH = 128;
export const MAX_MUTATION_ID_LENGTH = 128;

/** Protocol §10: permanent per-item error codes — drop, do not retry. */
const PERMANENT_ERRORS = new Set([
  'unknown_entity',
  'read_only_entity',
  'forbidden',
  'mutation_id_reused'
]);

/* ------------------------------ helpers --------------------------------- */

interface PersistedState {
  records: Record<string, SyncRecordEntry>;
  cursors: Record<string, number>;
  outbox: OutboxEntry[];
  conflictLog: ConflictLogEntry[];
  lastSyncAt: string | null;
}

function emptyState(): PersistedState {
  return { records: {}, cursors: {}, outbox: [], conflictLog: [], lastSyncAt: null };
}

function recordKey(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}

function randomMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mut-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Exact UTF-8 byte length without relying on TextEncoder (Hermes-safe). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------- factory -------------------------------- */

export function createSyncStore(options: SyncStoreOptions): SyncStore {
  const storage = options.storage;
  const transport = options.transport;
  const pullLimit = options.pullLimit ?? 200;
  const now = options.now ?? (() => new Date());
  const nextMutationId = options.mutationId ?? randomMutationId;

  let state = emptyState();
  let syncing = false;
  let lastError: string | null = null;
  let hydrated = false;
  let hydratePromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  let statusSnapshot: SyncStoreStatus = buildStatus();

  function buildStatus(): SyncStoreStatus {
    return {
      hydrated,
      syncing,
      pending: state.outbox.length,
      conflictsResolved: state.conflictLog.length,
      lastSyncAt: state.lastSyncAt,
      lastError,
      cursors: { ...state.cursors }
    };
  }

  function notify(): void {
    statusSnapshot = buildStatus();
    for (const listener of listeners) listener();
  }

  async function persist(): Promise<void> {
    await storage.setItem(SYNC_STORAGE_KEY, JSON.stringify(state));
  }

  function ensureHydrated(): Promise<void> {
    hydratePromise ??= (async () => {
      try {
        const raw = await storage.getItem(SYNC_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<PersistedState>;
          state = {
            records: parsed.records ?? {},
            cursors: parsed.cursors ?? {},
            outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
            conflictLog: Array.isArray(parsed.conflictLog) ? parsed.conflictLog : [],
            lastSyncAt: parsed.lastSyncAt ?? null
          };
        }
      } catch {
        // Corrupt payload: start clean rather than crash the app.
        state = emptyState();
      }
      hydrated = true;
      notify();
    })();
    return hydratePromise;
  }

  function applyPullItem(item: SyncPullItem, entity: string): void {
    state.records[recordKey(entity, item.entityId)] = {
      entity,
      entityId: item.entityId,
      version: item.version,
      deleted: item.deleted,
      // Tombstone: purge the payload, keep the version (§7).
      payload: item.deleted ? null : item.payload
    };
  }

  async function pullEntity(entity: string): Promise<PullSummary> {
    await ensureHydrated();
    let pages = 0;
    let applied = 0;
    for (;;) {
      const since = state.cursors[entity] ?? 0;
      const page = await transport.pull({ entity, since, limit: pullLimit });
      if (page.items.length === 0 && page.hasMore) {
        // Empty page claiming more rows would loop forever — fail loudly.
        throw new Error(`Sync protocol violation: empty pull page with hasMore for ${entity}`);
      }
      for (const item of page.items) {
        applyPullItem(item, entity);
        applied += 1;
      }
      // Monotonic cursor (§6): never regress, even on empty pages.
      state.cursors[entity] = Math.max(since, page.cursor);
      pages += 1;
      // Persist per page so a crash mid-sync resumes incrementally.
      await persist();
      if (!page.hasMore) break;
    }
    notify();
    return { entity, pages, applied, cursor: state.cursors[entity] ?? 0 };
  }

  async function enqueue(input: EnqueueInput): Promise<OutboxEntry> {
    await ensureHydrated();
    if (input.entity.length < 1 || input.entity.length > MAX_ENTITY_KEY_LENGTH) {
      throw new Error(`entity must be 1–${MAX_ENTITY_KEY_LENGTH} characters`);
    }
    if (input.entityId.length < 1 || input.entityId.length > MAX_ENTITY_ID_LENGTH) {
      throw new Error(`entityId must be 1–${MAX_ENTITY_ID_LENGTH} characters`);
    }
    if (input.op === 'upsert') {
      if (input.payload === undefined) {
        throw new Error('upsert mutations require a payload');
      }
      const bytes = utf8ByteLength(JSON.stringify(input.payload));
      if (bytes > MAX_PAYLOAD_BYTES) {
        throw new Error(`payload exceeds the 64 KiB per-item limit (${bytes} bytes)`);
      }
    }

    const clientMutationId = input.clientMutationId ?? nextMutationId();
    if (clientMutationId.length < 1 || clientMutationId.length > MAX_MUTATION_ID_LENGTH) {
      throw new Error(`clientMutationId must be 1–${MAX_MUTATION_ID_LENGTH} characters`);
    }
    // One logical mutation, one outbox entry (§5): re-enqueueing the same
    // clientMutationId returns the existing entry unchanged.
    const existing = state.outbox.find((entry) => entry.clientMutationId === clientMutationId);
    if (existing) return existing;

    const confirmed = state.records[recordKey(input.entity, input.entityId)];
    const entry: OutboxEntry = {
      entity: input.entity,
      entityId: input.entityId,
      clientMutationId,
      baseVersion: confirmed?.version ?? 0,
      op: input.op,
      payload: input.op === 'upsert' ? input.payload : undefined,
      enqueuedAt: now().toISOString()
    };
    state = { ...state, outbox: [...state.outbox, entry] };
    await persist();
    notify();
    return entry;
  }

  function handleApplied(entry: OutboxEntry, result: SyncPushResultItem): void {
    state.records[recordKey(entry.entity, entry.entityId)] = {
      entity: entry.entity,
      entityId: entry.entityId,
      version: result.newVersion ?? entry.baseVersion + 1,
      deleted: entry.op === 'delete',
      payload: entry.op === 'upsert' ? entry.payload : null
    };
  }

  function handleConflict(entry: OutboxEntry, result: SyncPushResultItem): void {
    // Server-wins v1 (§4): adopt the server state verbatim, drop the local
    // change, and keep an audit trail for the UI.
    const serverVersion = result.serverVersion ?? entry.baseVersion;
    state.records[recordKey(entry.entity, entry.entityId)] = {
      entity: entry.entity,
      entityId: entry.entityId,
      version: serverVersion,
      deleted: result.serverPayload == null,
      payload: result.serverPayload ?? null
    };
    state.conflictLog = [
      ...state.conflictLog,
      {
        entity: entry.entity,
        entityId: entry.entityId,
        clientMutationId: entry.clientMutationId,
        serverVersion,
        resolution: 'server-wins',
        resolvedAt: now().toISOString()
      }
    ];
  }

  async function pushPending(): Promise<PushSummary> {
    await ensureHydrated();
    const summary: PushSummary = {
      batches: 0,
      applied: 0,
      conflicts: 0,
      dropped: 0,
      retried: 0,
      remaining: state.outbox.length
    };

    // Each entry queued at call time is attempted at most once per call —
    // transient failures wait for the next sync pass instead of hammering
    // the API in a tight loop.
    const attempted = new Set<string>();
    for (;;) {
      const batch = state.outbox
        .filter((entry) => !attempted.has(entry.clientMutationId))
        .slice(0, PUSH_BATCH_SIZE);
      if (batch.length === 0) break;
      for (const entry of batch) attempted.add(entry.clientMutationId);

      let response: { results: SyncPushResultItem[] };
      try {
        response = await transport.push(batch);
      } catch (error) {
        // Transport failure (offline/5xx/401): leave the whole outbox
        // untouched — clientMutationIds stay stable for the retry (§10).
        summary.transportError = errorMessage(error);
        break;
      }
      summary.batches += 1;

      const kept: OutboxEntry[] = [];
      for (const entry of batch) {
        const result = response.results.find(
          (candidate) =>
            candidate.clientMutationId === entry.clientMutationId &&
            candidate.entity === entry.entity &&
            candidate.entityId === entry.entityId
        );
        if (!result) {
          // Server omitted an outcome (contract violation): keep and retry.
          kept.push(entry);
          summary.retried += 1;
          continue;
        }
        if (result.status === 'applied') {
          handleApplied(entry, result);
          summary.applied += 1;
        } else if (result.status === 'conflict') {
          handleConflict(entry, result);
          summary.conflicts += 1;
        } else if (result.error && PERMANENT_ERRORS.has(result.error)) {
          // Permanent: drop the mutation, surface via the summary (§10).
          summary.dropped += 1;
        } else {
          // Transient (apply_failed / replay_unavailable / unknown): retry.
          kept.push(entry);
          summary.retried += 1;
        }
      }
      // Rebuild the outbox: resolved entries drop out, transient-kept ones
      // retain FIFO position ahead of entries not attempted yet (including
      // anything enqueued while the request was in flight).
      const inBatch = new Set(batch.map((entry) => entry.clientMutationId));
      const rest = state.outbox.filter((entry) => !inBatch.has(entry.clientMutationId));
      state = { ...state, outbox: [...kept, ...rest] };
      await persist();
      notify();
    }

    summary.remaining = state.outbox.length;
    return summary;
  }

  async function syncNow(entities: readonly string[]): Promise<SyncSummary> {
    await ensureHydrated();
    syncing = true;
    notify();
    const summary: SyncSummary = { pulled: [], pushed: null, errors: [] };
    try {
      for (const entity of entities) {
        try {
          summary.pulled.push(await pullEntity(entity));
        } catch (error) {
          // Pull failure keeps the cache intact (state applied so far stays
          // valid); record the failure and move on to the next entity.
          summary.errors.push({ phase: 'pull', entity, message: errorMessage(error) });
        }
      }
      try {
        summary.pushed = await pushPending();
        if (summary.pushed.transportError) {
          summary.errors.push({ phase: 'push', message: summary.pushed.transportError });
        }
      } catch (error) {
        summary.errors.push({ phase: 'push', message: errorMessage(error) });
      }
      lastError = summary.errors[0]?.message ?? null;
      if (summary.errors.length === 0) {
        state = { ...state, lastSyncAt: now().toISOString() };
        await persist();
      }
    } finally {
      syncing = false;
      notify();
    }
    return summary;
  }

  function getRecords(entity: string): SyncRecordView[] {
    const views = new Map<string, SyncRecordView>();
    for (const record of Object.values(state.records)) {
      if (record.entity !== entity || record.deleted) continue;
      views.set(record.entityId, {
        entity,
        entityId: record.entityId,
        version: record.version,
        payload: record.payload,
        pending: false
      });
    }
    // Optimistic overlay: pending outbox mutations shape what the UI shows
    // until the server rules on them (latest outbox entry wins per record).
    for (const entry of state.outbox) {
      if (entry.entity !== entity) continue;
      if (entry.op === 'delete') {
        views.delete(entry.entityId);
      } else {
        const base = views.get(entry.entityId);
        views.set(entry.entityId, {
          entity,
          entityId: entry.entityId,
          version: base?.version ?? entry.baseVersion,
          payload: entry.payload,
          pending: true
        });
      }
    }
    // Server-confirmed records newest (highest version) first; pending
    // local-only records (version 0) lead the list.
    return [...views.values()].sort((a, b) => {
      if (a.version === 0 && b.version !== 0) return -1;
      if (b.version === 0 && a.version !== 0) return 1;
      return b.version - a.version;
    });
  }

  return {
    hydrate: ensureHydrated,
    getStatus: () => statusSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRecords,
    getCursor: (entity) => state.cursors[entity] ?? 0,
    getOutbox: () => state.outbox,
    getConflictLog: () => state.conflictLog,
    pullEntity,
    enqueue,
    pushPending,
    syncNow,
    fetchServerStatus: () => transport.status()
  };
}
