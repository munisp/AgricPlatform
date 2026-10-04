import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type { DataExportRequest, DataSubjectRequest, RetentionPolicy } from '@agric-platform/shared';
import type {
  DataExportRequestRepository,
  DataSubjectRequestRepository,
  RetentionPolicyRepository
} from './compliance.repository.js';

/** Bounded retries for the export-no CAS race (audit C2-13). */
const EXPORT_NO_MAX_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

const DSR_COLUMNS =
  'id, user_id, type, status, requested_at, completed_at, detail';

const EXPORT_COLUMNS = 'id, user_id, export_no, status, requested_at, completed_at, storage_ref';

/**
 * PostgreSQL implementations for the NDPA compliance stores (migration
 * 040_compliance.sql: compliance.data_subject_requests, data_export_requests,
 * retention_policies).
 *
 * Export numbering (audit C2-13) is atomic in the database:
 * compliance.export_counters holds one row per user, incremented inside an
 * INSERT … ON CONFLICT … DO UPDATE … RETURNING — concurrent export requests
 * can never reuse a sequence number. The export row insert may still race a
 * UNIQUE(user_id, export_no) conflict if a retry replays mid-flight; that
 * path re-reads the counter and retries up to EXPORT_NO_MAX_ATTEMPTS times,
 * then fails loudly.
 */
export class PgDataSubjectRequestRepository implements DataSubjectRequestRepository {
  constructor(private readonly pool: pg.Pool) {}

  async record(request: DataSubjectRequest): Promise<DataSubjectRequest> {
    await this.pool.query(
      `INSERT INTO compliance.data_subject_requests
         (id, user_id, type, status, requested_at, completed_at, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        request.id,
        request.userId,
        request.type,
        request.status,
        request.requestedAt,
        request.completedAt ?? null,
        request.detail ?? null
      ]
    );
    return request;
  }

  async findById(id: string): Promise<DataSubjectRequest | undefined> {
    const result = await this.pool.query(
      `SELECT ${DSR_COLUMNS} FROM compliance.data_subject_requests WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<DataSubjectRequest> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Data subject request '${id}' not found`);
    }
    return found;
  }

  async findByUser(userId: string): Promise<DataSubjectRequest[]> {
    const result = await this.pool.query(
      `SELECT ${DSR_COLUMNS} FROM compliance.data_subject_requests
       WHERE user_id = $1 ORDER BY requested_at, id`,
      [userId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async update(id: string, patch: Partial<DataSubjectRequest>): Promise<DataSubjectRequest> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    if (patch.detail !== undefined) push('detail', patch.detail);
    if (assignments.length === 0) {
      return this.getById(id);
    }
    params.push(id);
    const result = await this.pool.query(
      `UPDATE compliance.data_subject_requests SET ${assignments.join(', ')}
       WHERE id = $${params.length} RETURNING ${DSR_COLUMNS}`,
      params
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Data subject request '${id}' not found`);
    }
    return this.fromRow(result.rows[0]);
  }

  async countClosedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM compliance.data_subject_requests
       WHERE status IN ('completed','rejected') AND completed_at IS NOT NULL AND completed_at < $1`,
      [cutoff]
    );
    return result.rows[0].n as number;
  }

  async anonymizeClosedBefore(
    cutoff: string,
    pseudonymFor: (userId: string) => string
  ): Promise<number> {
    // Per-row pseudonym (HMAC keyed per user) cannot be computed in SQL;
    // iterate the small closed-set instead.
    const closed = await this.pool.query(
      `SELECT ${DSR_COLUMNS} FROM compliance.data_subject_requests
       WHERE status IN ('completed','rejected') AND completed_at IS NOT NULL AND completed_at < $1`,
      [cutoff]
    );
    let changed = 0;
    for (const row of closed.rows) {
      const tombstone = pseudonymFor(row.user_id as string);
      if (tombstone === row.user_id) continue;
      const updated = await this.pool.query(
        'UPDATE compliance.data_subject_requests SET user_id = $2 WHERE id = $1 AND user_id <> $2',
        [row.id, tombstone]
      );
      changed += updated.rowCount ?? 0;
    }
    return changed;
  }

  async purgeClosedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM compliance.data_subject_requests
       WHERE status IN ('completed','rejected') AND completed_at IS NOT NULL AND completed_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  private fromRow(row: Record<string, unknown>): DataSubjectRequest {
    return {
      id: row.id as string,
      userId: row.user_id,
      type: row.type as DataSubjectRequest['type'],
      status: row.status as DataSubjectRequest['status'],
      requestedAt: new Date(row.requested_at as string).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : undefined,
      detail: (row.detail as string | null) ?? undefined
    };
  }
}

export class PgDataExportRequestRepository implements DataExportRequestRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Allocates the next export_no for a user atomically. The counter row is
   * the single writer-side lock: INSERT … ON CONFLICT increments and
   * RETURNS the new value in one statement.
   */
  private async nextExportNo(userId: string): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO compliance.export_counters (user_id, next_export_no)
       VALUES ($1, 2)
       ON CONFLICT (user_id)
       DO UPDATE SET next_export_no = compliance.export_counters.next_export_no + 1
       RETURNING next_export_no - 1 AS export_no`,
      [userId]
    );
    return Number(result.rows[0].export_no);
  }

  async record(request: Omit<DataExportRequest, 'exportNo'>): Promise<DataExportRequest> {
    for (let attempt = 1; attempt <= EXPORT_NO_MAX_ATTEMPTS; attempt += 1) {
      const exportNo = await this.nextExportNo(request.userId);
      try {
        await this.pool.query(
          `INSERT INTO compliance.data_export_requests
             (id, user_id, export_no, status, requested_at, completed_at, storage_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            request.id,
            request.userId,
            exportNo,
            request.status,
            request.requestedAt,
            request.completedAt ?? null,
            request.storageRef ?? null
          ]
        );
        return { ...request, exportNo };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // A replayed/duplicated insert already holds that (user, export_no);
        // re-allocate and retry.
      }
    }
    throw new ConflictException(
      `data export request numbering failed after ${EXPORT_NO_MAX_ATTEMPTS} attempts for user '${request.userId}'`
    );
  }

  async findById(id: string): Promise<DataExportRequest | undefined> {
    const result = await this.pool.query(
      `SELECT ${EXPORT_COLUMNS} FROM compliance.data_export_requests WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<DataExportRequest> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Data export request '${id}' not found`);
    }
    return found;
  }

  async findByUser(userId: string): Promise<DataExportRequest[]> {
    const result = await this.pool.query(
      `SELECT ${EXPORT_COLUMNS} FROM compliance.data_export_requests
       WHERE user_id = $1 ORDER BY export_no`,
      [userId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async update(id: string, patch: Partial<DataExportRequest>): Promise<DataExportRequest> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    if (patch.storageRef !== undefined) push('storage_ref', patch.storageRef);
    if (assignments.length === 0) {
      return this.getById(id);
    }
    params.push(id);
    const result = await this.pool.query(
      `UPDATE compliance.data_export_requests SET ${assignments.join(', ')}
       WHERE id = $${params.length} RETURNING ${EXPORT_COLUMNS}`,
      params
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Data export request '${id}' not found`);
    }
    return this.fromRow(result.rows[0]);
  }

  private fromRow(row: Record<string, unknown>): DataExportRequest {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      exportNo: Number(row.export_no),
      status: row.status as DataExportRequest['status'],
      requestedAt: new Date(row.requested_at as string).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : undefined,
      storageRef: (row.storage_ref as string | null) ?? undefined
    };
  }
}

export class PgRetentionPolicyRepository implements RetentionPolicyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<RetentionPolicy[]> {
    const result = await this.pool.query(
      'SELECT entity, retention_days, anonymize_before_purge, updated_at FROM compliance.retention_policies ORDER BY entity'
    );
    return result.rows.map((row) => ({
      entity: row.entity as string,
      retentionDays: Number(row.retention_days),
      anonymizeBeforePurge: Boolean(row.anonymize_before_purge),
      updatedAt: new Date(row.updated_at as string).toISOString()
    }));
  }

  async upsert(policy: RetentionPolicy): Promise<RetentionPolicy> {
    await this.pool.query(
      `INSERT INTO compliance.retention_policies (entity, retention_days, anonymize_before_purge, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (entity) DO UPDATE SET
         retention_days = EXCLUDED.retention_days,
         anonymize_before_purge = EXCLUDED.anonymize_before_purge,
         updated_at = EXCLUDED.updated_at`,
      [policy.entity, policy.retentionDays, policy.anonymizeBeforePurge, policy.updatedAt]
    );
    return policy;
  }
}

export function createPgDataSubjectRequestRepository(
  pool: pg.Pool
): PgDataSubjectRequestRepository {
  return new PgDataSubjectRequestRepository(pool);
}

export function createPgDataExportRequestRepository(
  pool: pg.Pool
): PgDataExportRequestRepository {
  return new PgDataExportRequestRepository(pool);
}

export function createPgRetentionPolicyRepository(pool: pg.Pool): PgRetentionPolicyRepository {
  return new PgRetentionPolicyRepository(pool);
}
