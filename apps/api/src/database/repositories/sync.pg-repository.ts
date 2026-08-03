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
  owner_id: string | null;
  updated_by: string | null;
  updated_at: Date;
  deleted: boolean;
}

function versionFromRow(row: EntityVersionRow): EntityVersionRecord {
  return {
    entity: row.entity,
    entityId: row.entity_id,
    // bigint arrives as a string; versions fit comfortably in Number.MAX_SAFE_INTEGER.
    version: Number(row.version),
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
 * sync.entity_versions (024_sync.sql). All mutations are single atomic
 * statements — no multi-statement transaction is needed because the version
 * check-and-set happens inside one INSERT/UPDATE ... RETURNING.
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

  async current(entity: string, entityId: string): Promise<EntityVersionRecord | undefined> {
    const result = await this.pool.query<EntityVersionRow>(
      `SELECT entity, entity_id, version, owner_id, updated_by, updated_at, deleted
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
      `SELECT entity, entity_id, version, owner_id, updated_by, updated_at, deleted
         FROM sync.entity_versions
        WHERE entity = $1 AND owner_id = $2 AND version > $3
        ORDER BY version ASC
        LIMIT $4`,
      [entity, ownerId, since, limit]
    );
    return result.rows.map(versionFromRow);
  }

  async maxVersion(entity: string, ownerId: string): Promise<number> {
    const result = await this.pool.query<{ max: string | null }>(
      `SELECT max(version) AS max FROM sync.entity_versions WHERE entity = $1 AND owner_id = $2`,
      [entity, ownerId]
    );
    return result.rows[0]?.max === null || result.rows[0]?.max === undefined
      ? 0
      : Number(result.rows[0].max);
  }
}

export class PgSyncCursorRepository implements SyncCursorRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(userId: string, entity: string): Promise<number> {
    const result = await this.pool.query<{ cursor: string }>(
      'SELECT cursor FROM sync.sync_cursors WHERE user_id = $1 AND entity = $2',
      [userId, entity]
    );
    return result.rows[0] ? Number(result.rows[0].cursor) : 0;
  }

  async set(userId: string, entity: string, cursor: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync.sync_cursors (user_id, entity, cursor, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, entity) DO UPDATE
         SET cursor = GREATEST(sync.sync_cursors.cursor, EXCLUDED.cursor),
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
