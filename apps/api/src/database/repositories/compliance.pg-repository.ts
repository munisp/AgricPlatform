import { BadRequestException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import { mapPgError, ts } from '../pg/pg-repository.base.js';
import type {
  ComplianceConsentRecord,
  ComplianceConsentRepository,
  DataSubjectRequest,
  DataSubjectRequestRepository,
  RetentionPolicy,
  RetentionPolicyRepository
} from './compliance.repository.js';

/**
 * PostgreSQL implementations of the Wave COMP compliance ports (migration
 * 021, schema `compliance`). Hand-rolled SQL mirrors the in-memory
 * implementations in compliance.repository.ts one-to-one; the pg contract
 * suite (test/pg) keeps them honest.
 */

// ---------------------------------------------------------------------------
// compliance.consent_records
// ---------------------------------------------------------------------------

interface ConsentRow {
  id: string;
  user_id: string;
  purpose: string;
  policy_version: string;
  granted_at: Date | string;
  revoked_at: Date | string | null;
  source: string;
}

function consentFromRow(row: ConsentRow): ComplianceConsentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    policyVersion: row.policy_version,
    grantedAt: ts(row.granted_at),
    ...(row.revoked_at ? { revokedAt: ts(row.revoked_at) } : {}),
    source: row.source
  };
}

const CONSENT_COLUMNS = 'id, user_id, purpose, policy_version, granted_at, revoked_at, source';

export class PgComplianceConsentRepository implements ComplianceConsentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: ComplianceConsentRecord): Promise<ComplianceConsentRecord> {
    try {
      await this.pool.query(
        `INSERT INTO compliance.consent_records
           (id, user_id, purpose, policy_version, granted_at, revoked_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.id,
          record.userId,
          record.purpose,
          record.policyVersion,
          record.grantedAt,
          record.revokedAt ?? null,
          record.source
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async findById(id: string): Promise<ComplianceConsentRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${CONSENT_COLUMNS} FROM compliance.consent_records WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? consentFromRow(result.rows[0]) : undefined;
  }

  async findByUser(userId: string): Promise<ComplianceConsentRecord[]> {
    const result = await this.pool.query(
      `SELECT ${CONSENT_COLUMNS} FROM compliance.consent_records
       WHERE user_id = $1 ORDER BY granted_at, id`,
      [userId]
    );
    return result.rows.map(consentFromRow);
  }

  async findActive(
    userId: string,
    purpose: string
  ): Promise<ComplianceConsentRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${CONSENT_COLUMNS} FROM compliance.consent_records
       WHERE user_id = $1 AND purpose = $2 AND revoked_at IS NULL
       ORDER BY granted_at DESC, id DESC LIMIT 1`,
      [userId, purpose]
    );
    return result.rows[0] ? consentFromRow(result.rows[0]) : undefined;
  }

  async revoke(id: string, revokedAt: string): Promise<ComplianceConsentRecord> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundException(`Consent record '${id}' not found`);
    }
    if (existing.revokedAt) {
      throw new BadRequestException(`Consent record '${id}' is already revoked`);
    }
    const result = await this.pool.query(
      `UPDATE compliance.consent_records SET revoked_at = $2 WHERE id = $1
       RETURNING ${CONSENT_COLUMNS}`,
      [id, revokedAt]
    );
    return consentFromRow(result.rows[0]);
  }

  async countRevokedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM compliance.consent_records
       WHERE revoked_at IS NOT NULL AND revoked_at < $1`,
      [cutoff]
    );
    return result.rows[0].n as number;
  }

  async anonymizeRevokedBefore(
    cutoff: string,
    pseudonymFor: (userId: string) => string
  ): Promise<number> {
    // Per-row tombstones keep the pseudonymisation function identical to the
    // in-memory path (deterministic salted hash per user id).
    const candidates = await this.pool.query(
      `SELECT id, user_id FROM compliance.consent_records
       WHERE revoked_at IS NOT NULL AND revoked_at < $1`,
      [cutoff]
    );
    let changed = 0;
    for (const row of candidates.rows as Array<{ id: string; user_id: string }>) {
      const tombstone = pseudonymFor(row.user_id);
      if (tombstone === row.user_id) continue;
      const result = await this.pool.query(
        `UPDATE compliance.consent_records SET user_id = $2 WHERE id = $1`,
        [row.id, tombstone]
      );
      changed += result.rowCount ?? 0;
    }
    return changed;
  }

  async purgeRevokedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM compliance.consent_records
       WHERE revoked_at IS NOT NULL AND revoked_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }
}

export function createPgComplianceConsentRepository(
  pool: pg.Pool
): PgComplianceConsentRepository {
  return new PgComplianceConsentRepository(pool);
}

// ---------------------------------------------------------------------------
// compliance.data_subject_requests
// ---------------------------------------------------------------------------

interface DsrRow {
  id: string;
  user_id: string;
  type: string;
  status: string;
  requested_at: Date | string;
  completed_at: Date | string | null;
  result_ref: string | null;
  note: string | null;
}

function dsrFromRow(row: DsrRow): DataSubjectRequest {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as DataSubjectRequest['type'],
    status: row.status as DataSubjectRequest['status'],
    requestedAt: ts(row.requested_at),
    ...(row.completed_at ? { completedAt: ts(row.completed_at) } : {}),
    ...(row.result_ref ? { resultRef: row.result_ref } : {}),
    ...(row.note ? { note: row.note } : {})
  };
}

const DSR_COLUMNS = 'id, user_id, type, status, requested_at, completed_at, result_ref, note';

/** Column whitelist for update patches. */
const DSR_MUTABLE_COLUMNS: Record<string, string> = {
  status: 'status',
  completedAt: 'completed_at',
  resultRef: 'result_ref',
  note: 'note',
  userId: 'user_id'
};

const CLOSED_BEFORE_WHERE =
  `status IN ('completed', 'rejected') AND completed_at IS NOT NULL AND completed_at < $1`;

export class PgDataSubjectRequestRepository implements DataSubjectRequestRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(request: DataSubjectRequest): Promise<DataSubjectRequest> {
    try {
      await this.pool.query(
        `INSERT INTO compliance.data_subject_requests
           (id, user_id, type, status, requested_at, completed_at, result_ref, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          request.id,
          request.userId,
          request.type,
          request.status,
          request.requestedAt,
          request.completedAt ?? null,
          request.resultRef ?? null,
          request.note ?? null
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return request;
  }

  async findById(id: string): Promise<DataSubjectRequest | undefined> {
    const result = await this.pool.query(
      `SELECT ${DSR_COLUMNS} FROM compliance.data_subject_requests WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? dsrFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<DataSubjectRequest> {
    const request = await this.findById(id);
    if (!request) {
      throw new NotFoundException(`Data subject request '${id}' not found`);
    }
    return request;
  }

  async findByUser(userId: string): Promise<DataSubjectRequest[]> {
    const result = await this.pool.query(
      `SELECT ${DSR_COLUMNS} FROM compliance.data_subject_requests
       WHERE user_id = $1 ORDER BY requested_at, id`,
      [userId]
    );
    return result.rows.map(dsrFromRow);
  }

  async update(id: string, patch: Partial<DataSubjectRequest>): Promise<DataSubjectRequest> {
    const entries = Object.entries(patch)
      .map(([key, value]) => ({ column: DSR_MUTABLE_COLUMNS[key], value }))
      .filter((entry) => entry.column !== undefined);
    if (entries.length === 0) {
      return this.getById(id);
    }
    const assignments = entries.map((entry, index) => `${entry.column} = $${index + 2}`).join(', ');
    const result = await this.pool.query(
      `UPDATE compliance.data_subject_requests SET ${assignments} WHERE id = $1
       RETURNING ${DSR_COLUMNS}`,
      [id, ...entries.map((entry) => entry.value ?? null)]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Data subject request '${id}' not found`);
    }
    return dsrFromRow(result.rows[0]);
  }

  async countClosedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM compliance.data_subject_requests WHERE ${CLOSED_BEFORE_WHERE}`,
      [cutoff]
    );
    return result.rows[0].n as number;
  }

  async anonymizeClosedBefore(
    cutoff: string,
    pseudonymFor: (userId: string) => string
  ): Promise<number> {
    const candidates = await this.pool.query(
      `SELECT id, user_id FROM compliance.data_subject_requests WHERE ${CLOSED_BEFORE_WHERE}`,
      [cutoff]
    );
    let changed = 0;
    for (const row of candidates.rows as Array<{ id: string; user_id: string }>) {
      const tombstone = pseudonymFor(row.user_id);
      if (tombstone === row.user_id) continue;
      const result = await this.pool.query(
        `UPDATE compliance.data_subject_requests SET user_id = $2 WHERE id = $1`,
        [row.id, tombstone]
      );
      changed += result.rowCount ?? 0;
    }
    return changed;
  }

  async purgeClosedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM compliance.data_subject_requests WHERE ${CLOSED_BEFORE_WHERE}`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }
}

export function createPgDataSubjectRequestRepository(
  pool: pg.Pool
): PgDataSubjectRequestRepository {
  return new PgDataSubjectRequestRepository(pool);
}

// ---------------------------------------------------------------------------
// compliance.retention_policies
// ---------------------------------------------------------------------------

interface RetentionPolicyRow {
  entity: string;
  retain_days: number;
  anonymize_not_delete: boolean;
  updated_at: Date | string;
}

function policyFromRow(row: RetentionPolicyRow): RetentionPolicy {
  return {
    entity: row.entity,
    retainDays: row.retain_days,
    anonymizeNotDelete: row.anonymize_not_delete,
    updatedAt: ts(row.updated_at)
  };
}

const POLICY_COLUMNS = 'entity, retain_days, anonymize_not_delete, updated_at';

export class PgRetentionPolicyRepository implements RetentionPolicyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<RetentionPolicy[]> {
    const result = await this.pool.query(
      `SELECT ${POLICY_COLUMNS} FROM compliance.retention_policies ORDER BY entity`
    );
    return result.rows.map(policyFromRow);
  }

  async findByEntity(entity: string): Promise<RetentionPolicy | undefined> {
    const result = await this.pool.query(
      `SELECT ${POLICY_COLUMNS} FROM compliance.retention_policies WHERE entity = $1`,
      [entity]
    );
    return result.rows[0] ? policyFromRow(result.rows[0]) : undefined;
  }

  async upsert(policy: RetentionPolicy): Promise<RetentionPolicy> {
    await this.pool.query(
      `INSERT INTO compliance.retention_policies (entity, retain_days, anonymize_not_delete, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity) DO UPDATE
         SET retain_days = EXCLUDED.retain_days,
             anonymize_not_delete = EXCLUDED.anonymize_not_delete,
             updated_at = EXCLUDED.updated_at`,
      [policy.entity, policy.retainDays, policy.anonymizeNotDelete, policy.updatedAt]
    );
    return policy;
  }
}

export function createPgRetentionPolicyRepository(pool: pg.Pool): PgRetentionPolicyRepository {
  return new PgRetentionPolicyRepository(pool);
}
