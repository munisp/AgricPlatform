import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type {
  FloatForecastCriteria,
  FloatForecastRecord,
  FloatForecastRepository,
  RebalanceAlertCriteria,
  RebalanceAlertRecord,
  RebalanceAlertRepository,
  RebalanceRunCriteria,
  RebalanceRunRecord,
  RebalanceRunRepository
} from './float-forecast.repository.js';

/**
 * PostgreSQL implementations over migration 073 (agent_banking schema).
 * Compare-and-set updates compile `expected` into WHERE fragments so a lost
 * race updates 0 rows → 409, mirroring the in-memory repositories used in
 * unit tests. The one-open-alert-per-agent-per-type dedupe is enforced by
 * the partial unique index rebalance_alerts_one_open_per_agent_type; the
 * nightly run treats a 23505 from it as "already queued" and moves on.
 */

function assertPgUnique(error: unknown, message: string): never {
  if ((error as { code?: string }).code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}

function toIso(value: unknown): string | undefined {
  return value === null || value === undefined
    ? undefined
    : new Date(value as string).toISOString();
}

function toDay(value: unknown): string {
  return new Date(value as string).toISOString().slice(0, 10);
}

export class PgFloatForecastRepository implements FloatForecastRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(record: FloatForecastRecord): Promise<FloatForecastRecord> {
    await this.pool.query(
      'INSERT INTO agent_banking.float_forecasts (id, agent_id, forecast_date, day_offset, target_date, ' +
        'horizon_days, predicted_net_flow_kobo, predicted_eod_float_kobo, basis, model_version, computed_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ' +
        'ON CONFLICT (agent_id, forecast_date, day_offset, model_version) DO UPDATE SET ' +
        'target_date = EXCLUDED.target_date, horizon_days = EXCLUDED.horizon_days, ' +
        'predicted_net_flow_kobo = EXCLUDED.predicted_net_flow_kobo, ' +
        'predicted_eod_float_kobo = EXCLUDED.predicted_eod_float_kobo, basis = EXCLUDED.basis, ' +
        'computed_at = EXCLUDED.computed_at',
      [
        record.id,
        record.agentId,
        record.forecastDate,
        record.dayOffset,
        record.targetDate,
        record.horizonDays,
        record.predictedNetFlowKobo,
        record.predictedEodFloatKobo,
        record.basis,
        record.modelVersion,
        record.computedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<FloatForecastRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.float_forecasts WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: FloatForecastCriteria): Promise<FloatForecastRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.agentId) {
      params.push(criteria.agentId);
      where.push(`agent_id = $${params.length}`);
    }
    if (criteria.forecastDate) {
      params.push(criteria.forecastDate);
      where.push(`forecast_date = $${params.length}`);
    }
    if (criteria.modelVersion) {
      params.push(criteria.modelVersion);
      where.push(`model_version = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.float_forecasts' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY agent_id, forecast_date, day_offset';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): FloatForecastRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      forecastDate: toDay(row.forecast_date),
      dayOffset: Number(row.day_offset),
      targetDate: toDay(row.target_date),
      horizonDays: Number(row.horizon_days),
      predictedNetFlowKobo: Number(row.predicted_net_flow_kobo),
      predictedEodFloatKobo: Number(row.predicted_eod_float_kobo),
      basis: row.basis as FloatForecastRecord['basis'],
      modelVersion: row.model_version as string,
      computedAt: toIso(row.computed_at) as string
    };
  }
}

const ALERT_COLUMNS: Record<string, string> = {
  alertType: 'alert_type',
  predictedBreachAt: 'predicted_breach_at',
  predictedEodFloatKobo: 'predicted_eod_float_kobo',
  thresholdKobo: 'threshold_kobo',
  status: 'status',
  runId: 'run_id',
  modelVersion: 'model_version',
  acknowledgedBy: 'acknowledged_by',
  acknowledgedAt: 'acknowledged_at',
  resolvedBy: 'resolved_by',
  resolvedAt: 'resolved_at',
  resolution: 'resolution',
  updatedAt: 'updated_at'
};

export class PgRebalanceAlertRepository implements RebalanceAlertRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: RebalanceAlertRecord): Promise<RebalanceAlertRecord> {
    try {
      await this.pool.query(
        'INSERT INTO agent_banking.rebalance_alerts (id, agent_id, alert_type, predicted_breach_at, ' +
          'predicted_eod_float_kobo, threshold_kobo, status, run_id, model_version, acknowledged_by, ' +
          'acknowledged_at, resolved_by, resolved_at, resolution, created_at, updated_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [
          record.id,
          record.agentId,
          record.alertType,
          record.predictedBreachAt,
          record.predictedEodFloatKobo,
          record.thresholdKobo,
          record.status,
          record.runId ?? null,
          record.modelVersion,
          record.acknowledgedBy ?? null,
          record.acknowledgedAt ?? null,
          record.resolvedBy ?? null,
          record.resolvedAt ?? null,
          record.resolution ?? null,
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (error) {
      assertPgUnique(error, 'A record with these unique values already exists');
    }
    return record;
  }

  async findById(id: string): Promise<RebalanceAlertRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.rebalance_alerts WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: RebalanceAlertCriteria): Promise<RebalanceAlertRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    if (criteria.agentId) {
      params.push(criteria.agentId);
      where.push(`agent_id = $${params.length}`);
    }
    if (criteria.alertType) {
      params.push(criteria.alertType);
      where.push(`alert_type = $${params.length}`);
    }
    if (criteria.runId) {
      params.push(criteria.runId);
      where.push(`run_id = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.rebalance_alerts' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<RebalanceAlertRecord>,
    expected: Partial<RebalanceAlertRecord>
  ): Promise<RebalanceAlertRecord> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(ALERT_COLUMNS)) {
      if (key in patch) {
        params.push(patch[key as keyof RebalanceAlertRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(ALERT_COLUMNS)) {
      if (key in expected) {
        const value = expected[key as keyof RebalanceAlertRecord];
        if (value === undefined || value === null) {
          where.push(`${column} IS NULL`);
        } else {
          params.push(value);
          where.push(`${column} = $${params.length}`);
        }
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.rebalance_alerts SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : '') +
        ' RETURNING *',
      params
    );
    if (result.rows.length === 0) {
      throw new ConflictException(`Rebalance alert '${id}' changed concurrently; reload and retry`);
    }
    return this.fromRow(result.rows[0]);
  }

  async claimForRun(id: string, runId: string, updatedAt: string): Promise<RebalanceAlertRecord> {
    const result = await this.pool.query(
      'UPDATE agent_banking.rebalance_alerts SET run_id = $2, updated_at = $3 ' +
        "WHERE id = $1 AND status = 'open' AND run_id IS NULL RETURNING *",
      [id, runId, updatedAt]
    );
    if (result.rows.length === 0) {
      throw new ConflictException(`Rebalance alert '${id}' changed concurrently; reload and retry`);
    }
    return this.fromRow(result.rows[0]);
  }

  private fromRow(row: Record<string, unknown>): RebalanceAlertRecord {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      alertType: row.alert_type as RebalanceAlertRecord['alertType'],
      predictedBreachAt: toDay(row.predicted_breach_at),
      predictedEodFloatKobo: Number(row.predicted_eod_float_kobo),
      thresholdKobo: Number(row.threshold_kobo),
      status: row.status as RebalanceAlertRecord['status'],
      ...(row.run_id === null ? {} : { runId: row.run_id as string }),
      modelVersion: row.model_version as string,
      ...(row.acknowledged_by === null ? {} : { acknowledgedBy: row.acknowledged_by as string }),
      ...(toIso(row.acknowledged_at) ? { acknowledgedAt: toIso(row.acknowledged_at) } : {}),
      ...(row.resolved_by === null ? {} : { resolvedBy: row.resolved_by as string }),
      ...(toIso(row.resolved_at) ? { resolvedAt: toIso(row.resolved_at) } : {}),
      ...(row.resolution === null ? {} : { resolution: row.resolution as string }),
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string
    };
  }
}

const RUN_COLUMNS: Record<string, string> = {
  status: 'status',
  alertCount: 'alert_count',
  notes: 'notes',
  updatedAt: 'updated_at'
};

export class PgRebalanceRunRepository implements RebalanceRunRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: RebalanceRunRecord): Promise<RebalanceRunRecord> {
    await this.pool.query(
      'INSERT INTO agent_banking.rebalance_runs (id, status, alert_count, notes, created_by, created_at, updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        record.id,
        record.status,
        record.alertCount,
        record.notes ?? null,
        record.createdBy,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<RebalanceRunRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM agent_banking.rebalance_runs WHERE id = $1', [id]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async find(criteria: RebalanceRunCriteria): Promise<RebalanceRunRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const sql =
      'SELECT * FROM agent_banking.rebalance_runs' +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => this.fromRow(row));
  }

  async updateExpected(
    id: string,
    patch: Partial<RebalanceRunRecord>,
    expected: Partial<RebalanceRunRecord>
  ): Promise<RebalanceRunRecord> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(RUN_COLUMNS)) {
      if (key in patch) {
        params.push(patch[key as keyof RebalanceRunRecord] ?? null);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(RUN_COLUMNS)) {
      if (key in expected) {
        params.push(expected[key as keyof RebalanceRunRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query(
      `UPDATE agent_banking.rebalance_runs SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : '') +
        ' RETURNING *',
      params
    );
    if (result.rows.length === 0) {
      throw new ConflictException(`Rebalance run '${id}' changed concurrently; reload and retry`);
    }
    return this.fromRow(result.rows[0]);
  }

  private fromRow(row: Record<string, unknown>): RebalanceRunRecord {
    return {
      id: row.id as string,
      status: row.status as RebalanceRunRecord['status'],
      alertCount: Number(row.alert_count),
      ...(row.notes === null ? {} : { notes: row.notes as string }),
      createdBy: row.created_by as string,
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string
    };
  }
}

export function createPgFloatForecastRepository(pool: pg.Pool): PgFloatForecastRepository {
  return new PgFloatForecastRepository(pool);
}

export function createPgRebalanceAlertRepository(pool: pg.Pool): PgRebalanceAlertRepository {
  return new PgRebalanceAlertRepository(pool);
}

export function createPgRebalanceRunRepository(pool: pg.Pool): PgRebalanceRunRepository {
  return new PgRebalanceRunRepository(pool);
}
