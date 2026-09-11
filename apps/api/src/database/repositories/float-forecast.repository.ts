import { ConflictException } from '@nestjs/common';

/**
 * Float Forecaster persistence ports (Stage 27, Innovation 15). Rows map to
 * migration 073 (agent_banking.float_forecasts / rebalance_alerts /
 * rebalance_runs). These tables hold OPERATIONAL records only — the
 * forecaster reads the finance ledger but never writes to it; every value
 * movement stays on the existing LedgerService paths.
 *
 * Dedupe doctrine: at most one OPEN alert per agent per type. The pg
 * implementation enforces it with the partial unique index from migration
 * 073; the in-memory implementation mirrors it so unit tests exercise the
 * same conflict semantics (a duplicate open alert surfaces as 409 and the
 * nightly run simply keeps the existing row — threshold crossings fire
 * exactly once).
 */

export const FORECAST_BASES = ['seasonal_trend', 'insufficient_history'] as const;
export type ForecastBasis = (typeof FORECAST_BASES)[number];

export const REBALANCE_ALERT_TYPES = ['depletion', 'excess'] as const;
export type RebalanceAlertType = (typeof REBALANCE_ALERT_TYPES)[number];

export const REBALANCE_ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type RebalanceAlertStatus = (typeof REBALANCE_ALERT_STATUSES)[number];

export const REBALANCE_RUN_STATUSES = ['planned', 'dispatched', 'completed', 'cancelled'] as const;
export type RebalanceRunStatus = (typeof REBALANCE_RUN_STATUSES)[number];

export interface FloatForecastRecord {
  id: string;
  agentId: string;
  /** ISO day the forecast was computed as-of (the run date). */
  forecastDate: string;
  /** 1..horizonDays for real predictions; 0 marks an insufficient-history row. */
  dayOffset: number;
  targetDate: string;
  horizonDays: number;
  predictedNetFlowKobo: number;
  predictedEodFloatKobo: number;
  basis: ForecastBasis;
  /** Pinned model identity; part of the rerun-identity UNIQUE key. */
  modelVersion: string;
  computedAt: string;
}

export interface FloatForecastCriteria {
  agentId?: string;
  forecastDate?: string;
  modelVersion?: string;
}

export interface RebalanceAlertRecord {
  id: string;
  agentId: string;
  alertType: RebalanceAlertType;
  /** ISO day the model predicts the threshold breach. */
  predictedBreachAt: string;
  predictedEodFloatKobo: number;
  thresholdKobo: number;
  status: RebalanceAlertStatus;
  runId?: string;
  modelVersion: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RebalanceAlertCriteria {
  status?: RebalanceAlertStatus;
  agentId?: string;
  alertType?: RebalanceAlertType;
  runId?: string;
}

export interface RebalanceRunRecord {
  id: string;
  status: RebalanceRunStatus;
  alertCount: number;
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RebalanceRunCriteria {
  status?: RebalanceRunStatus;
}

export interface FloatForecastRepository {
  /**
   * Rerun-idempotent write keyed on (agentId, forecastDate, dayOffset,
   * modelVersion): a same-day re-run refreshes the prediction instead of
   * duplicating the row.
   */
  upsert(record: FloatForecastRecord): Promise<FloatForecastRecord>;
  findById(id: string): Promise<FloatForecastRecord | undefined>;
  find(criteria: FloatForecastCriteria): Promise<FloatForecastRecord[]>;
}

export interface RebalanceAlertRepository {
  /** Throws ConflictException when an open alert already exists for (agentId, alertType). */
  create(record: RebalanceAlertRecord): Promise<RebalanceAlertRecord>;
  findById(id: string): Promise<RebalanceAlertRecord | undefined>;
  find(criteria: RebalanceAlertCriteria): Promise<RebalanceAlertRecord[]>;
  /** Compare-and-set on status (and other expected fields); conflict → 409. */
  updateExpected(
    id: string,
    patch: Partial<RebalanceAlertRecord>,
    expected: Partial<RebalanceAlertRecord>
  ): Promise<RebalanceAlertRecord>;
  /**
   * Guarded claim for a rebalance run: succeeds only while the alert is
   * still open AND unclaimed (runId unset); a lost race surfaces as 409 so
   * an alert can never ride two runs.
   */
  claimForRun(id: string, runId: string, updatedAt: string): Promise<RebalanceAlertRecord>;
}

export interface RebalanceRunRepository {
  create(record: RebalanceRunRecord): Promise<RebalanceRunRecord>;
  findById(id: string): Promise<RebalanceRunRecord | undefined>;
  find(criteria: RebalanceRunCriteria): Promise<RebalanceRunRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<RebalanceRunRecord>,
    expected: Partial<RebalanceRunRecord>
  ): Promise<RebalanceRunRecord>;
}

// ---------------------------------------------------------- in-memory ----

function assertFound<T>(record: T | undefined, what: string, id: string): T {
  if (!record) {
    throw new ConflictException(`${what} '${id}' changed concurrently; reload and retry`);
  }
  return record;
}

function checkExpected<T>(current: T, expected: Partial<T>, what: string, id: string): void {
  for (const [key, value] of Object.entries(expected)) {
    if (current[key as keyof T] !== value) {
      throw new ConflictException(`${what} '${id}' changed concurrently; reload and retry`);
    }
  }
}

export class InMemoryFloatForecastRepository implements FloatForecastRepository {
  private readonly items = new Map<string, FloatForecastRecord>();

  async upsert(record: FloatForecastRecord): Promise<FloatForecastRecord> {
    // Mirror the pg UNIQUE(agent_id, forecast_date, day_offset, model_version)
    // rerun-identity key: a same-day re-run refreshes in place.
    for (const existing of this.items.values()) {
      if (
        existing.agentId === record.agentId &&
        existing.forecastDate === record.forecastDate &&
        existing.dayOffset === record.dayOffset &&
        existing.modelVersion === record.modelVersion
      ) {
        const refreshed = { ...record, id: existing.id };
        this.items.set(existing.id, structuredClone(refreshed));
        return structuredClone(refreshed);
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<FloatForecastRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: FloatForecastCriteria): Promise<FloatForecastRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.agentId || item.agentId === criteria.agentId) &&
          (!criteria.forecastDate || item.forecastDate === criteria.forecastDate) &&
          (!criteria.modelVersion || item.modelVersion === criteria.modelVersion)
      )
      .sort((a, b) =>
        a.agentId === b.agentId
          ? a.forecastDate === b.forecastDate
            ? a.dayOffset - b.dayOffset
            : a.forecastDate.localeCompare(b.forecastDate)
          : a.agentId.localeCompare(b.agentId)
      )
      .map((item) => structuredClone(item));
  }
}

export class InMemoryRebalanceAlertRepository implements RebalanceAlertRepository {
  private readonly items = new Map<string, RebalanceAlertRecord>();

  async create(record: RebalanceAlertRecord): Promise<RebalanceAlertRecord> {
    // Mirror the pg partial UNIQUE index: one OPEN alert per agent per type.
    if (record.status === 'open') {
      for (const existing of this.items.values()) {
        if (
          existing.agentId === record.agentId &&
          existing.alertType === record.alertType &&
          existing.status === 'open'
        ) {
          throw new ConflictException('A record with these unique values already exists');
        }
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<RebalanceAlertRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: RebalanceAlertCriteria): Promise<RebalanceAlertRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.status || item.status === criteria.status) &&
          (!criteria.agentId || item.agentId === criteria.agentId) &&
          (!criteria.alertType || item.alertType === criteria.alertType) &&
          (!criteria.runId || item.runId === criteria.runId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<RebalanceAlertRecord>,
    expected: Partial<RebalanceAlertRecord>
  ): Promise<RebalanceAlertRecord> {
    const current = assertFound(this.items.get(id), 'Rebalance alert', id);
    checkExpected(current, expected, 'Rebalance alert', id);
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }

  async claimForRun(id: string, runId: string, updatedAt: string): Promise<RebalanceAlertRecord> {
    const current = assertFound(this.items.get(id), 'Rebalance alert', id);
    if (current.status !== 'open' || current.runId !== undefined) {
      throw new ConflictException(`Rebalance alert '${id}' changed concurrently; reload and retry`);
    }
    const updated = { ...current, runId, updatedAt };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryRebalanceRunRepository implements RebalanceRunRepository {
  private readonly items = new Map<string, RebalanceRunRecord>();

  async create(record: RebalanceRunRecord): Promise<RebalanceRunRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<RebalanceRunRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: RebalanceRunCriteria): Promise<RebalanceRunRecord[]> {
    return [...this.items.values()]
      .filter((item) => !criteria.status || item.status === criteria.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<RebalanceRunRecord>,
    expected: Partial<RebalanceRunRecord>
  ): Promise<RebalanceRunRecord> {
    const current = assertFound(this.items.get(id), 'Rebalance run', id);
    checkExpected(current, expected, 'Rebalance run', id);
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export function createInMemoryFloatForecastRepository(): InMemoryFloatForecastRepository {
  return new InMemoryFloatForecastRepository();
}

export function createInMemoryRebalanceAlertRepository(): InMemoryRebalanceAlertRepository {
  return new InMemoryRebalanceAlertRepository();
}

export function createInMemoryRebalanceRunRepository(): InMemoryRebalanceRunRepository {
  return new InMemoryRebalanceRunRepository();
}
