import { ConflictException } from '@nestjs/common';

/**
 * Float Sentinel persistence ports (Stage 27, fraud schema, migration 059).
 *
 * - fraud.rules: IMMUTABLE, versioned rule registry. Tuning inserts a new
 *   (code, version) row; params on an existing version are never updated.
 *   `enabled` is the only mutable column (individual rule kill-switch).
 * - fraud.alerts: dedup-keyed alert queue. upsertAlert is ON CONFLICT
 *   (dedup_key) DO NOTHING, so replaying the outbox stream converges to the
 *   same rows instead of double-alerting (mark-after consumer doctrine).
 * - fraud.cases: admin case queue grouping alerts; resolution is a guarded
 *   CAS (open → resolved) so concurrent officers get a 409, not a silent
 *   overwrite — mirroring the loan/topup state-machine convention.
 */

export const FRAUD_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FraudSeverity = (typeof FRAUD_SEVERITIES)[number];

export const FRAUD_SUBJECT_TYPES = ['agent', 'voucher', 'account'] as const;
export type FraudSubjectType = (typeof FRAUD_SUBJECT_TYPES)[number];

export const FRAUD_ALERT_STATUSES = ['open', 'confirmed', 'dismissed'] as const;
export type FraudAlertStatus = (typeof FRAUD_ALERT_STATUSES)[number];

export const FRAUD_CASE_STATUSES = ['open', 'resolved'] as const;
export type FraudCaseStatus = (typeof FRAUD_CASE_STATUSES)[number];

export interface FraudRuleRecord {
  code: string;
  version: number;
  description: string;
  params: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export interface FraudAlertRecord {
  id: string;
  /** rule_code:rule_version:firing_event_id:subject_type:subject_id — UNIQUE. */
  dedupKey: string;
  ruleCode: string;
  ruleVersion: number;
  subjectType: FraudSubjectType;
  subjectId: string;
  severity: FraudSeverity;
  status: FraudAlertStatus;
  /** Contributing event ids + computed values (reviewer-reproducible basis). */
  evidence: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

export interface FraudCaseRecord {
  id: string;
  alertIds: string[];
  assignee?: string;
  status: FraudCaseStatus;
  resolution?: string;
  createdBy: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface FraudAlertCriteria {
  status?: FraudAlertStatus;
  ruleCode?: string;
  subjectType?: FraudSubjectType;
  subjectId?: string;
}

export interface FraudCaseCriteria {
  status?: FraudCaseStatus;
  assignee?: string;
}

export interface FraudSentinelRepository {
  // ------------------------------------------------------------------ rules
  /** All versions of all rules, ordered (code, version). */
  listRules(): Promise<FraudRuleRecord[]>;
  /** The highest-version row for a code, if any. */
  currentRule(code: string): Promise<FraudRuleRecord | undefined>;
  /** Every enabled current-version rule. */
  enabledRules(): Promise<FraudRuleRecord[]>;
  /**
   * Inserts a new rule version. ConflictException when (code, version)
   * already exists — versions are immutable, callers must bump the version.
   */
  insertRuleVersion(rule: FraudRuleRecord): Promise<FraudRuleRecord>;
  /** Flips the only mutable rule column. Undefined when the version is unknown. */
  setRuleEnabled(code: string, version: number, enabled: boolean): Promise<FraudRuleRecord | undefined>;

  // ----------------------------------------------------------------- alerts
  /**
   * Idempotent insert keyed by dedupKey. Returns the stored row and whether
   * THIS call created it (false = replay/concurrent twin; the stored row is
   * returned unchanged and no alert event may be re-published).
   */
  upsertAlert(
    alert: Omit<FraudAlertRecord, 'status' | 'resolvedAt' | 'resolvedBy' | 'resolution'>
  ): Promise<{ alert: FraudAlertRecord; created: boolean }>;
  findAlertById(id: string): Promise<FraudAlertRecord | undefined>;
  findAlerts(criteria: FraudAlertCriteria): Promise<FraudAlertRecord[]>;
  /** ruleCode → total alert count (the rules endpoint's per-rule hit counts). */
  countAlertsByRule(): Promise<Record<string, number>>;
  /**
   * Guarded transition open → confirmed|dismissed. ConflictException when the
   * alert is already resolved (concurrent officer loses the race).
   */
  transitionAlert(
    id: string,
    patch: { status: 'confirmed' | 'dismissed'; resolvedBy: string; resolvedAt: string; resolution?: string },
    expected: { status: 'open' }
  ): Promise<FraudAlertRecord>;

  // ------------------------------------------------------------------ cases
  createCase(record: FraudCaseRecord): Promise<FraudCaseRecord>;
  findCaseById(id: string): Promise<FraudCaseRecord | undefined>;
  findCases(criteria: FraudCaseCriteria): Promise<FraudCaseRecord[]>;
  /** Guarded open → resolved transition (ConflictException on a lost race). */
  resolveCase(
    id: string,
    patch: { resolution: string; resolvedBy: string; resolvedAt: string },
    expected: { status: 'open' }
  ): Promise<FraudCaseRecord>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (default when PG_POOL is absent; unit-test double).
// ---------------------------------------------------------------------------

export class InMemoryFraudSentinelRepository implements FraudSentinelRepository {
  private readonly rules = new Map<string, FraudRuleRecord>();
  private readonly alerts = new Map<string, FraudAlertRecord>();
  private readonly cases = new Map<string, FraudCaseRecord>();

  private static ruleKey(code: string, version: number): string {
    return `${code}:${version}`;
  }

  async listRules(): Promise<FraudRuleRecord[]> {
    return [...this.rules.values()]
      .map((rule) => structuredClone(rule))
      .sort((a, b) => a.code.localeCompare(b.code) || a.version - b.version);
  }

  async currentRule(code: string): Promise<FraudRuleRecord | undefined> {
    const versions = (await this.listRules()).filter((rule) => rule.code === code);
    return versions[versions.length - 1];
  }

  async enabledRules(): Promise<FraudRuleRecord[]> {
    const byCode = new Map<string, FraudRuleRecord>();
    for (const rule of await this.listRules()) {
      byCode.set(rule.code, rule);
    }
    return [...byCode.values()].filter((rule) => rule.enabled);
  }

  async insertRuleVersion(rule: FraudRuleRecord): Promise<FraudRuleRecord> {
    const key = InMemoryFraudSentinelRepository.ruleKey(rule.code, rule.version);
    if (this.rules.has(key)) {
      throw new ConflictException(
        `Fraud rule ${rule.code} version ${rule.version} already exists — rule versions are immutable; bump the version`
      );
    }
    const stored = structuredClone(rule);
    this.rules.set(key, stored);
    return structuredClone(stored);
  }

  async setRuleEnabled(
    code: string,
    version: number,
    enabled: boolean
  ): Promise<FraudRuleRecord | undefined> {
    const stored = this.rules.get(InMemoryFraudSentinelRepository.ruleKey(code, version));
    if (!stored) {
      return undefined;
    }
    stored.enabled = enabled;
    return structuredClone(stored);
  }

  async upsertAlert(
    alert: Omit<FraudAlertRecord, 'status' | 'resolvedAt' | 'resolvedBy' | 'resolution'>
  ): Promise<{ alert: FraudAlertRecord; created: boolean }> {
    const existing = [...this.alerts.values()].find((row) => row.dedupKey === alert.dedupKey);
    if (existing) {
      return { alert: structuredClone(existing), created: false };
    }
    const stored: FraudAlertRecord = { ...structuredClone(alert), status: 'open' };
    this.alerts.set(stored.id, stored);
    return { alert: structuredClone(stored), created: true };
  }

  async findAlertById(id: string): Promise<FraudAlertRecord | undefined> {
    const found = this.alerts.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async findAlerts(criteria: FraudAlertCriteria): Promise<FraudAlertRecord[]> {
    return [...this.alerts.values()]
      .filter(
        (alert) =>
          (criteria.status === undefined || alert.status === criteria.status) &&
          (criteria.ruleCode === undefined || alert.ruleCode === criteria.ruleCode) &&
          (criteria.subjectType === undefined || alert.subjectType === criteria.subjectType) &&
          (criteria.subjectId === undefined || alert.subjectId === criteria.subjectId)
      )
      .map((alert) => structuredClone(alert))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async countAlertsByRule(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const alert of this.alerts.values()) {
      counts[alert.ruleCode] = (counts[alert.ruleCode] ?? 0) + 1;
    }
    return counts;
  }

  async transitionAlert(
    id: string,
    patch: { status: 'confirmed' | 'dismissed'; resolvedBy: string; resolvedAt: string; resolution?: string },
    expected: { status: 'open' }
  ): Promise<FraudAlertRecord> {
    const stored = this.alerts.get(id);
    if (!stored) {
      throw new ConflictException(`Fraud alert '${id}' not found`);
    }
    if (stored.status !== expected.status) {
      throw new ConflictException(
        `Fraud alert '${id}' is already ${stored.status} — expected status '${expected.status}'`
      );
    }
    Object.assign(stored, patch);
    return structuredClone(stored);
  }

  async createCase(record: FraudCaseRecord): Promise<FraudCaseRecord> {
    if (this.cases.has(record.id)) {
      throw new ConflictException(`Fraud case '${record.id}' already exists`);
    }
    const stored = structuredClone(record);
    this.cases.set(stored.id, stored);
    return structuredClone(stored);
  }

  async findCaseById(id: string): Promise<FraudCaseRecord | undefined> {
    const found = this.cases.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async findCases(criteria: FraudCaseCriteria): Promise<FraudCaseRecord[]> {
    return [...this.cases.values()]
      .filter(
        (record) =>
          (criteria.status === undefined || record.status === criteria.status) &&
          (criteria.assignee === undefined || record.assignee === criteria.assignee)
      )
      .map((record) => structuredClone(record))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async resolveCase(
    id: string,
    patch: { resolution: string; resolvedBy: string; resolvedAt: string },
    expected: { status: 'open' }
  ): Promise<FraudCaseRecord> {
    const stored = this.cases.get(id);
    if (!stored) {
      throw new ConflictException(`Fraud case '${id}' not found`);
    }
    if (stored.status !== expected.status) {
      throw new ConflictException(
        `Fraud case '${id}' is already ${stored.status} — expected status '${expected.status}'`
      );
    }
    stored.status = 'resolved';
    Object.assign(stored, patch);
    return structuredClone(stored);
  }
}

export function createInMemoryFraudSentinelRepository(): InMemoryFraudSentinelRepository {
  return new InMemoryFraudSentinelRepository();
}
