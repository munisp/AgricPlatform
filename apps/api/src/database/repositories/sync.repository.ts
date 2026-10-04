/**
 * Sync protocol v2 persistence ports (Wave SYNCSRV; migrations 024_sync.sql
 * + 080_sync_change_seq.sql).
 *
 * Three ports back the record-level offline sync protocol
 * (docs/sync-protocol.md):
 *
 *   - EntityVersionRepository  per-record version ledger (sync.entity_versions).
 *     Bumps are performed by application code, NOT by database triggers:
 *     pgsql-ast-parser cannot parse CREATE TRIGGER, so linted migrations
 *     cannot carry one (see the design note in 024_sync.sql).
 *     v2: every bump also stamps `change_seq` from a GLOBAL monotonic
 *     sequence (080); pull cursors operate on `change_seq`, while the
 *     per-record `version` remains the push CAS counter only.
 *   - SyncCursorRepository     server-side per-(user, entity) pull cursor copy.
 *   - SyncMutationRepository   push idempotency ledger (sync.mutations),
 *     the events.processed_events dedup pattern with a replayable outcome.
 */
export interface EntityVersionRecord {
  entity: string;
  entityId: string;
  /** Per-record optimistic-concurrency counter (push baseVersion CAS only). */
  version: number;
  /**
   * Global monotonic change sequence (v2). Strictly increasing across ALL
   * records; pull cursors (`since`) operate on this, never on `version`.
   */
  changeSeq: number;
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
   * Claim-guarded apply (v2 push discipline, docs/sync-protocol.md §9): the
   * version row is CAS-claimed FIRST — atomically, advancing only when the
   * current version equals `expectedVersion` (0 = the record must not exist
   * yet) — and `apply` (the entity write) runs only while the claim
   * is held. A concurrent claimant for the same record either blocks until
   * this claim completes (pg: the claiming UPDATE holds the row lock to
   * COMMIT) or fails the CAS immediately; the loser receives null and NEVER
   * runs `apply`, so a losing payload can never touch the source row.
   *
   * If `apply` throws, the claim is rolled back (pg: transaction ROLLBACK;
   * in-memory: the previous row is restored), so the ledger never advances
   * without the entity write. Returns the new version plus `apply`'s value,
   * or null on a version mismatch — callers translate null into a CONFLICT
   * result, never a silent overwrite.
   */
  applyGuarded<T>(
    input: EntityVersionBump & { expectedVersion: number },
    apply: () => Promise<T>
  ): Promise<{ version: number; value: T } | null>;
  current(entity: string, entityId: string): Promise<EntityVersionRecord | undefined>;
  /**
   * Rows with `change_seq` strictly greater than `since` for one caller's
   * scope, ordered by change_seq ascending (v2 pull cursor order).
   * Tombstones are included.
   */
  listSince(
    entity: string,
    ownerId: string,
    since: number,
    limit: number
  ): Promise<EntityVersionRecord[]>;
  /** Highest change_seq visible in the caller's scope (0 when never synced). */
  maxChangeSeq(entity: string, ownerId: string): Promise<number>;
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
  /**
   * Retention sweep (v2, L-09): deletes up to `limit` rows recorded before
   * `cutoffIso`, oldest first. Idempotent; replays older than the retention
   * window are realistically gone, so pruning cannot break dedup.
   */
  pruneOlderThan(cutoffIso: string, limit: number): Promise<number>;
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
  /** Global monotonic change sequence (mirrors the pg sequence in 080). */
  private changeSeq = 0;

  private key(entity: string, entityId: string): string {
    return `${entity}${entityId}`;
  }

  private stamp(input: EntityVersionBump, version: number): EntityVersionRecord {
    this.changeSeq += 1;
    return {
      entity: input.entity,
      entityId: input.entityId,
      version,
      changeSeq: this.changeSeq,
      ownerId: input.ownerId,
      updatedBy: input.updatedBy,
      updatedAt: new Date().toISOString(),
      deleted: input.deleted ?? false
    };
  }

  async bump(input: EntityVersionBump): Promise<number> {
    const key = this.key(input.entity, input.entityId);
    const existing = this.rows.get(key);
    const row = this.stamp(input, (existing?.version ?? 0) + 1);
    this.rows.set(key, row);
    return row.version;
  }

  async applyGuarded<T>(
    input: EntityVersionBump & { expectedVersion: number },
    apply: () => Promise<T>
  ): Promise<{ version: number; value: T } | null> {
    const key = this.key(input.entity, input.entityId);
    const previous = this.rows.get(key);
    if ((previous?.version ?? 0) !== input.expectedVersion) {
      // Claim lost before it began — the caller's apply never runs.
      return null;
    }
    // Atomic claim: the version row advances BEFORE the entity write, so a
    // concurrent claimant at the same expectedVersion fails its CAS even if
    // it interleaves while `apply` is in flight.
    const claimed = this.stamp(input, input.expectedVersion + 1);
    this.rows.set(key, claimed);
    try {
      const value = await apply();
      return { version: claimed.version, value };
    } catch (error) {
      // Claim rollback: the ledger never advances without the entity write.
      // The consumed change_seq is NOT reused (sequence semantics: gaps ok).
      if (previous) {
        this.rows.set(key, previous);
      } else {
        this.rows.delete(key);
      }
      throw error;
    }
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
        (row) => row.entity === entity && row.ownerId === ownerId && row.changeSeq > since
      )
      .sort((a, b) => a.changeSeq - b.changeSeq)
      .slice(0, limit)
      .map(cloneVersion);
  }

  async maxChangeSeq(entity: string, ownerId: string): Promise<number> {
    let max = 0;
    for (const row of this.rows.values()) {
      if (row.entity === entity && row.ownerId === ownerId && row.changeSeq > max) {
        max = row.changeSeq;
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
    // Monotonic (L-08): mirror the pg GREATEST — a stale cursor write never
    // regresses the recorded position.
    const key = `${userId}${entity}`;
    this.cursors.set(key, Math.max(this.cursors.get(key) ?? 0, cursor));
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

  async pruneOlderThan(cutoffIso: string, limit: number): Promise<number> {
    const stale = [...this.rows.entries()]
      .filter(([, row]) => row.createdAt < cutoffIso)
      .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(0, limit));
    for (const [key] of stale) {
      this.rows.delete(key);
    }
    return stale.length;
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

// ---------------------------------------------------------------------------
// GAP-M11: failed version-bump reconciliation ledger (sync.version_bump_retries).
// ---------------------------------------------------------------------------

/** A queued compensating version bump (GAP-M11, migration 123). */
export interface SyncVersionBumpRetryRecord {
  entity: string;
  entityId: string;
  ownerId: string | null;
  actorId: string | null;
  deleted: boolean;
  /** Reconcile attempts so far (bounded by the reconciler). */
  attempts: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Durable queue for version bumps whose initial recordChange failed
 * (GAP-M11). The reconciliation pass re-applies the unconditional bump and
 * removes the row on success; exhausted rows (attempts over the budget) are
 * KEPT for ops inspection — dropping one would be permanent sync
 * invisibility for that record.
 */
export interface SyncVersionBumpRetryRepository {
  /**
   * Atomic upsert (INSERT ... ON CONFLICT DO UPDATE on pg): a repeated
   * failure for the same record refreshes the change + error and resets
   * the attempt budget (the newest write deserves a fresh chance).
   */
  enqueue(change: SyncVersionBumpRetryInput, error: string): Promise<void>;
  /** Pending retries, oldest-updated first, bounded by `limit`. */
  listPending(limit: number): Promise<SyncVersionBumpRetryRecord[]>;
  /** Removes the row after a successful compensating bump. */
  remove(entity: string, entityId: string): Promise<void>;
  /** Increments the attempt counter and stamps the latest error; returns the new count. */
  recordAttempt(entity: string, entityId: string, error: string): Promise<number>;
}

export interface SyncVersionBumpRetryInput {
  entity: string;
  entityId: string;
  ownerId: string | null;
  actorId: string | null;
  deleted: boolean;
}

export class InMemorySyncVersionBumpRetryRepository implements SyncVersionBumpRetryRepository {
  private readonly rows = new Map<string, SyncVersionBumpRetryRecord>();

  private key(entity: string, entityId: string): string {
    return `${entity} ${entityId}`;
  }

  async enqueue(change: SyncVersionBumpRetryInput, error: string): Promise<void> {
    const key = this.key(change.entity, change.entityId);
    const existing = this.rows.get(key);
    const now = new Date().toISOString();
    this.rows.set(key, {
      entity: change.entity,
      entityId: change.entityId,
      ownerId: change.ownerId,
      actorId: change.actorId,
      deleted: change.deleted,
      attempts: 0,
      lastError: error,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  async listPending(limit: number): Promise<SyncVersionBumpRetryRecord[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, Math.max(0, limit))
      .map((row) => ({ ...row }));
  }

  async remove(entity: string, entityId: string): Promise<void> {
    this.rows.delete(this.key(entity, entityId));
  }

  async recordAttempt(entity: string, entityId: string, error: string): Promise<number> {
    const row = this.rows.get(this.key(entity, entityId));
    if (!row) {
      return 0;
    }
    row.attempts += 1;
    row.lastError = error;
    row.updatedAt = new Date().toISOString();
    return row.attempts;
  }
}

export function createInMemorySyncVersionBumpRetryRepository(): InMemorySyncVersionBumpRetryRepository {
  return new InMemorySyncVersionBumpRetryRepository();
}
