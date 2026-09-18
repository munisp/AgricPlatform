import type pg from 'pg';
import type {
  EntityVersionBump,
  EntityVersionRecord,
  EntityVersionRepository,
  SyncCursorRepository,
  SyncMutationRecord,
  SyncMutationRepository
} from './sync.repository.js';

interface EntityVersionRow {
  entity: string;
  entity_id: string;
  version: string;
  change_seq: string;
  owner_id: string | null;
  updated_by: string | null;
  updated_at: Date;
  deleted: boolean;
}

const VERSION_COLUMNS =
  'entity, entity_id, version, change_seq, owner_id, updated_by, updated_at, deleted';

function versionFromRow(row: EntityVersionRow): EntityVersionRecord {
  return {
    entity: row.entity,
    entityId: row.entity_id,
    // bigint arrives as a string; versions fit comfortably in Number.MAX_SAFE_INTEGER.
    version: Number(row.version),
    changeSeq: Number(row.change_seq),
    ownerId: row.owner_id,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
    deleted: row.deleted
  };
}

interface SyncMutationRow {
  user_id: string;
  client_mutation_id: string;
  entity: string;
  entity_id: string;
  op: 'upsert' | 'delete';
  status: 'applied' | 'conflict' | 'error';
  new_version: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

function mutationFromRow(row: SyncMutationRow): SyncMutationRecord {
  return {
    userId: row.user_id,
    clientMutationId: row.client_mutation_id,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    status: row.status,
    newVersion: row.new_version === null ? null : Number(row.new_version),
    detail: row.detail,
    createdAt: row.created_at.toISOString()
  };
}

/**
 * sync.entity_versions (024_sync.sql + 080_sync_change_seq.sql). Plain bumps
 * are single atomic statements (INSERT/UPDATE ... RETURNING); v2 adds
 * applyGuarded, which holds the claiming statement's transaction open across
 * the entity write so a concurrent claimant can never write the source row.
 * Every bump stamps change_seq from the global sequence (column default).
 */
export class PgEntityVersionRepository implements EntityVersionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async bump(input: EntityVersionBump): Promise<number> {
    const result = await this.pool.query<{ version: string }>(
      `INSERT INTO sync.entity_versions (entity, entity_id, version, owner_id, updated_by, deleted)
       VALUES ($1, $2, 1, $3, $4, $5)
       ON CONFLICT (entity, entity_id) DO UPDATE
         SET version    = sync.entity_versions.version + 1,
             owner_id   = EXCLUDED.owner_id,
             updated_by = EXCLUDED.updated_by,
             updated_at = now(),
             deleted    = EXCLUDED.deleted
       RETURNING version`,
      [input.entity, input.entityId, input.ownerId, input.updatedBy, input.deleted ?? false]
    );
    return Number(result.rows[0].version);
  }

  async bumpExpected(input: EntityVersionBump & { expectedVersion: number }): Promise<number | null> {
    if (input.expectedVersion === 0) {
      // Create path: only the first writer wins the insert.
      const inserted = await this.pool.query<{ version: string }>(
        `INSERT INTO sync.entity_versions (entity, entity_id, version, owner_id, updated_by, deleted)
         VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (entity, entity_id) DO NOTHING
         RETURNING version`,
        [input.entity, input.entityId, input.ownerId, input.updatedBy, input.deleted ?? false]
      );
      return inserted.rows[0] ? Number(inserted.rows[0].version) : null;
    }
    const updated = await this.pool.query<{ version: string }>(
      `UPDATE sync.entity_versions
         SET version    = version + 1,
             owner_id   = $3,
             updated_by = $4,
             updated_at = now(),
             deleted    = $5
       WHERE entity = $1 AND entity_id = $2 AND version = $6
       RETURNING version`,
      [
        input.entity,
        input.entityId,
        input.ownerId,
        input.updatedBy,
        input.deleted ?? false,
        input.expectedVersion
      ]
    );
    return updated.rows[0] ? Number(updated.rows[0].version) : null;
  }

  /**
   * Claim-guarded apply (v2): the version row is CAS-claimed inside a
   * transaction whose claiming INSERT/UPDATE holds the row lock until
   * COMMIT. `apply` (the entity write) runs only while the claim is held;
   * a concurrent claimant blocks on the row lock, then fails its CAS once
   * this claim commits — so the loser NEVER runs `apply` and its payload
   * never touches the source row. If `apply` throws the whole claim rolls
   * back, so the ledger never advances without the entity write.
   *
   * The entity write itself runs on the caller's own connections (the
   * service's repositories); the guarantee this provides is serialization:
   * exactly one claimant per expectedVersion may perform its entity write.
   */
  async applyGuarded<T>(
    input: EntityVersionBump & { expectedVersion: number },
    apply: () => Promise<T>
  ): Promise<{ version: number; value: T } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimSql =
        input.expectedVersion === 0
          ? `INSERT INTO sync.entity_versions (entity, entity_id, version, owner_id, updated_by, deleted)
             VALUES ($1, $2, 1, $3, $4, $5)
             ON CONFLICT (entity, entity_id) DO NOTHING
             RETURNING version`
          : `UPDATE sync.entity_versions
                SET version    = version + 1,
                    owner_id   = $3,
                    updated_by = $4,
                    updated_at = now(),
                    deleted    = $5
              WHERE entity = $1 AND entity_id = $2 AND version = $6
              RETURNING version`;
      const params: unknown[] = [
        input.entity,
        input.entityId,
        input.ownerId,
        input.updatedBy,
        input.deleted ?? false
      ];
      if (input.expectedVersion !== 0) {
        params.push(input.expectedVersion);
      }
      const claimed = await client.query<{ version: string }>(claimSql, params);
      if (!claimed.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const version = Number(claimed.rows[0].version);
      try {
        const value = await apply();
        await client.query('COMMIT');
        return { version, value };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async current(entity: string, entityId: string): Promise<EntityVersionRecord | undefined> {
    const result = await this.pool.query<EntityVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM sync.entity_versions
        WHERE entity = $1 AND entity_id = $2`,
      [entity, entityId]
    );
    return result.rows[0] ? versionFromRow(result.rows[0]) : undefined;
  }

  async listSince(
    entity: string,
    ownerId: string,
    since: number,
    limit: number
  ): Promise<EntityVersionRecord[]> {
    const result = await this.pool.query<EntityVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM sync.entity_versions
        WHERE entity = $1 AND owner_id = $2 AND change_seq > $3
        ORDER BY change_seq ASC
        LIMIT $4`,
      [entity, ownerId, since, limit]
    );
    return result.rows.map(versionFromRow);
  }

  async maxChangeSeq(entity: string, ownerId: string): Promise<number> {
    const result = await this.pool.query<{ max: string | null }>(
      `SELECT max(change_seq) AS max FROM sync.entity_versions WHERE entity = $1 AND owner_id = $2`,
      [entity, ownerId]
    );
    return result.rows[0]?.max === null || result.rows[0]?.max === undefined
      ? 0
      : Number(result.rows[0].max);
  }
}

export class PgSyncCursorRepository implements SyncCursorRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * v2: rows recorded under protocol v1 (`protocol = 1`, the 080 default)
   * are stale — their cursor numbers belong to the per-record-version
   * domain and are meaningless as change_seq cursors — so they read as 0.
   */
  async get(userId: string, entity: string): Promise<number> {
    const result = await this.pool.query<{ cursor: string; protocol: number }>(
      'SELECT cursor, protocol FROM sync.sync_cursors WHERE user_id = $1 AND entity = $2',
      [userId, entity]
    );
    return result.rows[0] && result.rows[0].protocol >= 2 ? Number(result.rows[0].cursor) : 0;
  }

  async set(userId: string, entity: string, cursor: number): Promise<void> {
    // Monotonic GREATEST applies only between v2 rows. A stale protocol-1 row's
    // cursor belongs to the per-record-version domain, so the first v2 write
    // REPLACES it (CI db-contract failure, 2026-09-18) — otherwise the legacy
    // value would poison every subsequent cursor read for that (user, entity).
    await this.pool.query(
      `INSERT INTO sync.sync_cursors (user_id, entity, cursor, protocol, updated_at)
       VALUES ($1, $2, $3, 2, now())
       ON CONFLICT (user_id, entity) DO UPDATE
         SET cursor = CASE WHEN sync.sync_cursors.protocol < 2
                           THEN EXCLUDED.cursor
                           ELSE GREATEST(sync.sync_cursors.cursor, EXCLUDED.cursor)
                      END,
             protocol = 2,
             updated_at = now()`,
      [userId, entity, cursor]
    );
  }

  /** Test/dev helper: mirrors the in-memory get for contract assertions. */
  async listForUser(userId: string): Promise<Array<{ entity: string; cursor: number }>> {
    const result = await this.pool.query<{ entity: string; cursor: string }>(
      'SELECT entity, cursor FROM sync.sync_cursors WHERE user_id = $1 ORDER BY entity',
      [userId]
    );
    return result.rows.map((row) => ({ entity: row.entity, cursor: Number(row.cursor) }));
  }
}

/** sync.mutations push idempotency ledger (024_sync.sql). */
export class PgSyncMutationRepository implements SyncMutationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async find(userId: string, clientMutationId: string): Promise<SyncMutationRecord | undefined> {
    const result = await this.pool.query<SyncMutationRow>(
      `SELECT user_id, client_mutation_id, entity, entity_id, op, status, new_version, detail, created_at
         FROM sync.mutations
        WHERE user_id = $1 AND client_mutation_id = $2`,
      [userId, clientMutationId]
    );
    return result.rows[0] ? mutationFromRow(result.rows[0]) : undefined;
  }

  async record(record: SyncMutationRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO sync.mutations
         (user_id, client_mutation_id, entity, entity_id, op, status, new_version, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, client_mutation_id) DO NOTHING`,
      [
        record.userId,
        record.clientMutationId,
        record.entity,
        record.entityId,
        record.op,
        record.status,
        record.newVersion,
        record.detail ? JSON.stringify(record.detail) : null
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async pruneOlderThan(cutoffIso: string, limit: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM sync.mutations
        WHERE ctid IN (
          SELECT ctid FROM sync.mutations
           WHERE created_at < $1
           ORDER BY created_at ASC
           LIMIT $2
        )`,
      [cutoffIso, Math.max(0, limit)]
    );
    return result.rowCount ?? 0;
  }
}

export function createPgEntityVersionRepository(pool: pg.Pool): PgEntityVersionRepository {
  return new PgEntityVersionRepository(pool);
}

export function createPgSyncCursorRepository(pool: pg.Pool): PgSyncCursorRepository {
  return new PgSyncCursorRepository(pool);
}

export function createPgSyncMutationRepository(pool: pg.Pool): PgSyncMutationRepository {
  return new PgSyncMutationRepository(pool);
}
