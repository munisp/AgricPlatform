import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type {
  FraudAlertCriteria,
  FraudAlertRecord,
  FraudCaseCriteria,
  FraudCaseRecord,
  FraudRuleRecord,
  FraudSentinelRepository
} from './fraud.repository.js';

/**
 * PostgreSQL Float Sentinel repository (fraud schema, migration 059).
 * Mirrors the in-memory implementation semantics exactly: dedup-keyed alert
 * upserts, immutable rule versions, guarded CAS transitions.
 */

interface RuleRow {
  code: string;
  version: number;
  description: string;
  params: Record<string, unknown>;
  enabled: boolean;
  created_by: string;
  created_at: Date;
}

interface AlertRow {
  id: string;
  dedup_key: string;
  rule_code: string;
  rule_version: number;
  subject_type: FraudAlertRecord['subjectType'];
  subject_id: string;
  severity: FraudAlertRecord['severity'];
  status: FraudAlertRecord['status'];
  evidence: Record<string, unknown>;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: string | null;
}

interface CaseRow {
  id: string;
  alert_ids: string[];
  assignee: string | null;
  status: FraudCaseRecord['status'];
  resolution: string | null;
  created_by: string;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

const RULE_COLUMNS = 'code, version, description, params, enabled, created_by, created_at';
const ALERT_COLUMNS =
  'id, dedup_key, rule_code, rule_version, subject_type, subject_id, severity, status, evidence, created_at, resolved_at, resolved_by, resolution';
const CASE_COLUMNS =
  'id, alert_ids, assignee, status, resolution, created_by, created_at, resolved_at, resolved_by';

function ruleFromRow(row: RuleRow): FraudRuleRecord {
  return {
    code: row.code,
    version: row.version,
    description: row.description,
    params: row.params ?? {},
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString()
  };
}

function alertFromRow(row: AlertRow): FraudAlertRecord {
  return {
    id: row.id,
    dedupKey: row.dedup_key,
    ruleCode: row.rule_code,
    ruleVersion: row.rule_version,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    severity: row.severity,
    status: row.status,
    evidence: row.evidence ?? {},
    createdAt: row.created_at.toISOString(),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
    ...(row.resolution ? { resolution: row.resolution } : {})
  };
}

function caseFromRow(row: CaseRow): FraudCaseRecord {
  return {
    id: row.id,
    alertIds: row.alert_ids ?? [],
    ...(row.assignee ? { assignee: row.assignee } : {}),
    status: row.status,
    ...(row.resolution ? { resolution: row.resolution } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {})
  };
}

export class PgFraudSentinelRepository implements FraudSentinelRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listRules(): Promise<FraudRuleRecord[]> {
    const result = await this.pool.query(
      `SELECT ${RULE_COLUMNS} FROM fraud.rules ORDER BY code, version`
    );
    return result.rows.map(ruleFromRow);
  }

  async currentRule(code: string): Promise<FraudRuleRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${RULE_COLUMNS} FROM fraud.rules WHERE code = $1 ORDER BY version DESC LIMIT 1`,
      [code]
    );
    return result.rows[0] ? ruleFromRow(result.rows[0]) : undefined;
  }

  async enabledRules(): Promise<FraudRuleRecord[]> {
    // Latest version per code, then filter to the enabled ones.
    const result = await this.pool.query(
      `SELECT DISTINCT ON (code) ${RULE_COLUMNS}
         FROM fraud.rules
        ORDER BY code, version DESC`
    );
    return result.rows.map(ruleFromRow).filter((rule: FraudRuleRecord) => rule.enabled);
  }

  async insertRuleVersion(rule: FraudRuleRecord): Promise<FraudRuleRecord> {
    try {
      const result = await this.pool.query(
        `INSERT INTO fraud.rules (code, version, description, params, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${RULE_COLUMNS}`,
        [rule.code, rule.version, rule.description, JSON.stringify(rule.params), rule.enabled, rule.createdBy]
      );
      return ruleFromRow(result.rows[0]);
    } catch (error) {
      // 23505 unique_violation — the (code, version) row already exists and
      // rule versions are immutable.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(
          `Fraud rule ${rule.code} version ${rule.version} already exists — rule versions are immutable; bump the version`
        );
      }
      throw error;
    }
  }

  async setRuleEnabled(
    code: string,
    version: number,
    enabled: boolean
  ): Promise<FraudRuleRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE fraud.rules SET enabled = $3 WHERE code = $1 AND version = $2 RETURNING ${RULE_COLUMNS}`,
      [code, version, enabled]
    );
    return result.rows[0] ? ruleFromRow(result.rows[0]) : undefined;
  }

  async upsertAlert(
    alert: Omit<FraudAlertRecord, 'status' | 'resolvedAt' | 'resolvedBy' | 'resolution'>
  ): Promise<{ alert: FraudAlertRecord; created: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO fraud.alerts
         (id, dedup_key, rule_code, rule_version, subject_type, subject_id, severity, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING ${ALERT_COLUMNS}`,
      [
        alert.id,
        alert.dedupKey,
        alert.ruleCode,
        alert.ruleVersion,
        alert.subjectType,
        alert.subjectId,
        alert.severity,
        JSON.stringify(alert.evidence)
      ]
    );
    if (result.rows[0]) {
      return { alert: alertFromRow(result.rows[0]), created: true };
    }
    // Replay/concurrent twin: return the stored row, unchanged.
    const existing = await this.pool.query(
      `SELECT ${ALERT_COLUMNS} FROM fraud.alerts WHERE dedup_key = $1`,
      [alert.dedupKey]
    );
    return { alert: alertFromRow(existing.rows[0]), created: false };
  }

  async findAlertById(id: string): Promise<FraudAlertRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${ALERT_COLUMNS} FROM fraud.alerts WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? alertFromRow(result.rows[0]) : undefined;
  }

  async findAlerts(criteria: FraudAlertCriteria): Promise<FraudAlertRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.status !== undefined) {
      values.push(criteria.status);
      where.push(`status = $${values.length}`);
    }
    if (criteria.ruleCode !== undefined) {
      values.push(criteria.ruleCode);
      where.push(`rule_code = $${values.length}`);
    }
    if (criteria.subjectType !== undefined) {
      values.push(criteria.subjectType);
      where.push(`subject_type = $${values.length}`);
    }
    if (criteria.subjectId !== undefined) {
      values.push(criteria.subjectId);
      where.push(`subject_id = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${ALERT_COLUMNS} FROM fraud.alerts${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY created_at, id`,
      values
    );
    return result.rows.map(alertFromRow);
  }

  async countAlertsByRule(): Promise<Record<string, number>> {
    const result = await this.pool.query(
      'SELECT rule_code, COUNT(*)::int AS count FROM fraud.alerts GROUP BY rule_code'
    );
    const counts: Record<string, number> = {};
    for (const row of result.rows as { rule_code: string; count: number }[]) {
      counts[row.rule_code] = row.count;
    }
    return counts;
  }

  async transitionAlert(
    id: string,
    patch: { status: 'confirmed' | 'dismissed'; resolvedBy: string; resolvedAt: string; resolution?: string },
    expected: { status: 'open' }
  ): Promise<FraudAlertRecord> {
    // Guarded write: only the open → confirmed|dismissed transition can
    // land; a concurrent resolution loses the race (rowCount 0 → 409).
    const result = await this.pool.query(
      `UPDATE fraud.alerts
          SET status = $2, resolved_by = $3, resolved_at = $4, resolution = $5
        WHERE id = $1 AND status = $6
        RETURNING ${ALERT_COLUMNS}`,
      [id, patch.status, patch.resolvedBy, patch.resolvedAt, patch.resolution ?? null, expected.status]
    );
    if (!result.rows[0]) {
      const existing = await this.findAlertById(id);
      throw new ConflictException(
        existing
          ? `Fraud alert '${id}' is already ${existing.status} — expected status '${expected.status}'`
          : `Fraud alert '${id}' not found`
      );
    }
    return alertFromRow(result.rows[0]);
  }

  async createCase(record: FraudCaseRecord): Promise<FraudCaseRecord> {
    try {
      const result = await this.pool.query(
        `INSERT INTO fraud.cases (id, alert_ids, assignee, status, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${CASE_COLUMNS}`,
        [record.id, record.alertIds, record.assignee ?? null, record.status, record.createdBy]
      );
      return caseFromRow(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException(`Fraud case '${record.id}' already exists`);
      }
      throw error;
    }
  }

  async findCaseById(id: string): Promise<FraudCaseRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${CASE_COLUMNS} FROM fraud.cases WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? caseFromRow(result.rows[0]) : undefined;
  }

  async findCases(criteria: FraudCaseCriteria): Promise<FraudCaseRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.status !== undefined) {
      values.push(criteria.status);
      where.push(`status = $${values.length}`);
    }
    if (criteria.assignee !== undefined) {
      values.push(criteria.assignee);
      where.push(`assignee = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${CASE_COLUMNS} FROM fraud.cases${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY created_at, id`,
      values
    );
    return result.rows.map(caseFromRow);
  }

  async resolveCase(
    id: string,
    patch: { resolution: string; resolvedBy: string; resolvedAt: string },
    expected: { status: 'open' }
  ): Promise<FraudCaseRecord> {
    const result = await this.pool.query(
      `UPDATE fraud.cases
          SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = $4
        WHERE id = $1 AND status = $5
        RETURNING ${CASE_COLUMNS}`,
      [id, patch.resolution, patch.resolvedBy, patch.resolvedAt, expected.status]
    );
    if (!result.rows[0]) {
      const existing = await this.findCaseById(id);
      throw new ConflictException(
        existing
          ? `Fraud case '${id}' is already ${existing.status} — expected status '${expected.status}'`
          : `Fraud case '${id}' not found`
      );
    }
    return caseFromRow(result.rows[0]);
  }
}

export function createPgFraudSentinelRepository(pool: pg.Pool): PgFraudSentinelRepository {
  return new PgFraudSentinelRepository(pool);
}
