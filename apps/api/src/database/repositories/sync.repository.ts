/**
 * Sync protocol v1 persistence ports (Wave SYNCSRV; migration 024_sync.sql).
 *
 * Three ports back the record-level offline sync protocol
 * (docs/sync-protocol.md):
 *
 *   - EntityVersionRepository  per-record version ledger (sync.entity_versions).
 *     Bumps are performed by application code, NOT by database triggers:
 *     pgsql-ast-parser cannot parse CREATE TRIGGER, so linted migrations
 *     cannot carry one (see the design note in 024_sync.sql).
 *   - SyncCursorRepository     server-side per-(user, entity) pull cursor copy.
 *   - SyncMutationRepository   push idempotency ledger (sync.mutations),
 *     the events.processed_events dedup pattern with a replayable outcome.
 */
export interface EntityVersionRecord {
  entity: string;
  entityId: string;
  version: number;
  /** Sync scope key captured at bump time (survives source-row deletion). */
  ownerId: string | null;
  updatedBy: string | null;
  updatedAt: string;
  deleted: boolean;
}

export interface EntityVersionBump {
  entity: string;
  entityId: string;
  ownerId: string | null;
  updatedBy: string | null;
  deleted?: boolean;
}

export interface EntityVersionRepository {
  /**
   * Unconditional bump: inserts version 1 or increments the existing row.
   * Returns the new version. Atomic on pg (INSERT ... ON CONFLICT DO UPDATE
   * ... RETURNING); synchronous check-and-set in memory.
   */
  bump(input: EntityVersionBump): Promise<number>;
  /**
   * Compare-and-set bump used by the push path: only advances when the
   * current version equals `expectedVersion` (0 = the record must not exist
   * yet). Returns the new version, or null on a version mismatch — callers
   * translate null into a CONFLICT result, never a silent overwrite.
   */
  bumpExpected(input: EntityVersionBump & { expectedVersion: number }): Promise<number | null>;
  current(entity: string, entityId: string): Promise<EntityVersionRecord | undefined>;
  /**
   * Versions strictly greater than `since` for one caller's scope, ordered
   * by version ascending (pull cursor order). Tombstones are included.
   */
  listSince(
    entity: string,
    ownerId: string,
    since: number,
    limit: number
  ): Promise<EntityVersionRecord[]>;
  /** Highest version visible in the caller's scope (0 when never synced). */
  maxVersion(entity: string, ownerId: string): Promise<number>;
}

export interface SyncCursorRepository {
  get(userId: string, entity: string): Promise<number>;
  set(userId: string, entity: string, cursor: number): Promise<void>;
}

export interface SyncMutationRecord {
  userId: string;
  clientMutationId: string;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  /** Per-item outcome recorded for idempotent replay. */
  status: 'applied' | 'conflict' | 'error';
  newVersion: number | null;
  /** Original per-item result payload replayed on retry. */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface SyncMutationRepository {
  find(userId: string, clientMutationId: string): Promise<SyncMutationRecord | undefined>;
  /**
   * Atomic insert (INSERT ... ON CONFLICT DO NOTHING on pg). Returns true
   * when this call recorded the mutation; false when the pair already
   * existed — the caller must then re-read and replay the stored outcome.
   */
  record(record: SyncMutationRecord): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementations (single-process mode; synchronous CAS semantics
// mirror the pg atomic statements exactly).
// ---------------------------------------------------------------------------

function cloneVersion(record: EntityVersionRecord): EntityVersionRecord {
  return { ...record };
}

export class InMemoryEntityVersionRepository implements EntityVersionRepository {
  private readonly rows = new Map<string, EntityVersionRecord>();

  private key(entity: string, entityId: string): string {
    return `${entity}${entityId}`;
  }

  async bump(input: EntityVersionBump): Promise<number> {
    const existing = this.rows.get(this.key(input.entity, input.entityId));
    const version = (existing?.version ?? 0) + 1;
    this.rows.set(this.key(input.entity, input.entityId), {
      entity: input.entity,
      entityId: input.entityId,
      version,
      ownerId: input.ownerId,
      updatedBy: input.updatedBy,
      updatedAt: new Date().toISOString(),
      deleted: input.deleted ?? false
    });
    return version;
  }

  async bumpExpected(input: EntityVersionBump & { expectedVersion: number }): Promise<number | null> {
    const existing = this.rows.get(this.key(input.entity, input.entityId));
    if ((existing?.version ?? 0) !== input.expectedVersion) {
      return null;
    }
    return this.bump(input);
  }

  async current(entity: string, entityId: string): Promise<EntityVersionRecord | undefined> {
    const row = this.rows.get(this.key(entity, entityId));
    return row ? cloneVersion(row) : undefined;
  }

  async listSince(
    entity: string,
    ownerId: string,
    since: number,
    limit: number
  ): Promise<EntityVersionRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) => row.entity === entity && row.ownerId === ownerId && row.version > since
      )
      .sort((a, b) => a.version - b.version)
      .slice(0, limit)
      .map(cloneVersion);
  }

  async maxVersion(entity: string, ownerId: string): Promise<number> {
    let max = 0;
    for (const row of this.rows.values()) {
      if (row.entity === entity && row.ownerId === ownerId && row.version > max) {
        max = row.version;
      }
    }
    return max;
  }
}

export class InMemorySyncCursorRepository implements SyncCursorRepository {
  private readonly cursors = new Map<string, number>();

  async get(userId: string, entity: string): Promise<number> {
    return this.cursors.get(`${userId}${entity}`) ?? 0;
  }

  async set(userId: string, entity: string, cursor: number): Promise<void> {
    this.cursors.set(`${userId}${entity}`, cursor);
  }
}

export class InMemorySyncMutationRepository implements SyncMutationRepository {
  private readonly rows = new Map<string, SyncMutationRecord>();

  async find(userId: string, clientMutationId: string): Promise<SyncMutationRecord | undefined> {
    const row = this.rows.get(`${userId}${clientMutationId}`);
    return row ? { ...row } : undefined;
  }

  async record(record: SyncMutationRecord): Promise<boolean> {
    const key = `${record.userId}${record.clientMutationId}`;
    if (this.rows.has(key)) {
      return false;
    }
    this.rows.set(key, { ...record });
    return true;
  }
}

export function createInMemoryEntityVersionRepository(): InMemoryEntityVersionRepository {
  return new InMemoryEntityVersionRepository();
}

export function createInMemorySyncCursorRepository(): InMemorySyncCursorRepository {
  return new InMemorySyncCursorRepository();
}

export function createInMemorySyncMutationRepository(): InMemorySyncMutationRepository {
  return new InMemorySyncMutationRepository();
}
