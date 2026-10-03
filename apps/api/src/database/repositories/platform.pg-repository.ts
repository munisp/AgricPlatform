import type pg from 'pg';
import type { FeatureFlag, FeatureFlagRepository } from './feature-flag.repository.js';
import type { ProcessedEventRepository } from './processed-event.repository.js';

interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  role_allowlist: string[];
  percentage: number;
  description: string;
  updated_at: Date;
}

function flagFromRow(row: FeatureFlagRow): FeatureFlag {
  return {
    key: row.key,
    enabled: row.enabled,
    roleAllowlist: row.role_allowlist ?? [],
    percentage: row.percentage,
    description: row.description,
    updatedAt: row.updated_at.toISOString()
  };
}

const FLAG_COLUMNS = 'key, enabled, role_allowlist, percentage, description, updated_at';

/** platform.feature_flags (Wave P). */
export class PgFeatureFlagRepository implements FeatureFlagRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(key: string): Promise<FeatureFlag | undefined> {
    const result = await this.pool.query(
      `SELECT ${FLAG_COLUMNS} FROM platform.feature_flags WHERE key = $1`,
      [key]
    );
    return result.rows[0] ? flagFromRow(result.rows[0]) : undefined;
  }

  async list(): Promise<FeatureFlag[]> {
    const result = await this.pool.query(
      `SELECT ${FLAG_COLUMNS} FROM platform.feature_flags ORDER BY key`
    );
    return result.rows.map(flagFromRow);
  }

  async upsert(flag: Omit<FeatureFlag, 'updatedAt'>): Promise<FeatureFlag> {
    const result = await this.pool.query(
      `INSERT INTO platform.feature_flags (key, enabled, role_allowlist, percentage, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              role_allowlist = EXCLUDED.role_allowlist,
              percentage = EXCLUDED.percentage,
              description = EXCLUDED.description,
              updated_at = now()
       RETURNING ${FLAG_COLUMNS}`,
      [flag.key, flag.enabled, flag.roleAllowlist, flag.percentage, flag.description]
    );
    return flagFromRow(result.rows[0]);
  }

  async remove(key: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM platform.feature_flags WHERE key = $1', [key]);
    return (result.rowCount ?? 0) > 0;
  }
}

/** events.processed_events (Wave P consumer-side dedup). */
export class PgProcessedEventRepository implements ProcessedEventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async tryRecord(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO events.processed_events (consumer, event_id)
       VALUES ($1, $2)
       ON CONFLICT (consumer, event_id) DO NOTHING`,
      [consumer, eventId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async has(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM events.processed_events WHERE consumer = $1 AND event_id = $2',
      [consumer, eventId]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async countProcessedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM events.processed_events
       WHERE processed_at < $1`,
      [cutoff]
    );
    return result.rows[0].n as number;
  }

  async purgeProcessedBefore(cutoff: string, limit: number): Promise<number> {
    // ctid-batched delete (sync.mutations pruneOlderThan pattern): one call
    // removes at most `limit` rows oldest-first, so a sweep never locks the
    // whole ledger in a single statement; the caller loops until a short
    // batch. Served by processed_events_processed_at_idx (migration 127).
    const result = await this.pool.query(
      `DELETE FROM events.processed_events
        WHERE ctid IN (
          SELECT ctid FROM events.processed_events
           WHERE processed_at < $1
           ORDER BY processed_at ASC
           LIMIT $2
        )`,
      [cutoff, Math.max(0, limit)]
    );
    return result.rowCount ?? 0;
  }
}

export function createPgFeatureFlagRepository(pool: pg.Pool): PgFeatureFlagRepository {
  return new PgFeatureFlagRepository(pool);
}

export function createPgProcessedEventRepository(pool: pg.Pool): PgProcessedEventRepository {
  return new PgProcessedEventRepository(pool);
}
