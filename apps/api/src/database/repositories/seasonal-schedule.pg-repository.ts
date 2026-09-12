import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  CreditSeasonalInstallment,
  CreditSeasonalSchedule,
  CreditSeasonalScheduleStatus
} from '@agric-platform/shared';
import { composeWhere, eq, mapPgError, ts, type WhereClause } from '../pg/pg-repository.base.js';
import type {
  SeasonalScheduleCriteria,
  SeasonalScheduleRepository
} from './seasonal-schedule.repository.js';

/**
 * PostgreSQL repository for SeasonSync seasonal schedules over
 * credit.seasonal_schedules (migration 055). Self-contained SQL keeps the
 * wave additive — no edits to the shared row-mappers module. The accept CAS
 * (previewed → accepted) is a single guarded UPDATE; the partial unique
 * index seasonal_schedules_one_accepted_uq is the database backstop for
 * exactly one accepted schedule per loan.
 */

interface SeasonalScheduleRow {
  id: string;
  loan_id: string;
  plot_id: string | null;
  crop: string;
  planting_date: string;
  harvest_window_start: string;
  harvest_window_end: string;
  installments: CreditSeasonalInstallment[];
  version: number;
  status: CreditSeasonalScheduleStatus;
  created_by: string;
  created_at: string;
  accepted_at: string | null;
}

function fromRow(row: SeasonalScheduleRow): CreditSeasonalSchedule {
  return {
    id: row.id,
    loanId: row.loan_id,
    plotId: row.plot_id ?? undefined,
    crop: row.crop,
    plantingDate: ts(row.planting_date).slice(0, 10),
    harvestWindowStart: ts(row.harvest_window_start).slice(0, 10),
    harvestWindowEnd: ts(row.harvest_window_end).slice(0, 10),
    installments: row.installments.map((installment) => ({
      sequence: Number(installment.sequence),
      dueAt: installment.dueAt,
      amountKobo: Number(installment.amountKobo)
    })),
    version: Number(row.version),
    status: row.status,
    createdBy: row.created_by,
    createdAt: ts(row.created_at),
    acceptedAt: row.accepted_at === null ? undefined : ts(row.accepted_at)
  };
}

export class PgSeasonalScheduleRepository implements SeasonalScheduleRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: CreditSeasonalSchedule): Promise<CreditSeasonalSchedule> {
    try {
      await this.pool.query(
        `INSERT INTO credit.seasonal_schedules
           (id, loan_id, plot_id, crop, planting_date, harvest_window_start,
            harvest_window_end, installments, version, status, created_by,
            created_at, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.loanId,
          record.plotId ?? null,
          record.crop,
          record.plantingDate,
          record.harvestWindowStart,
          record.harvestWindowEnd,
          JSON.stringify(record.installments),
          record.version,
          record.status,
          record.createdBy,
          record.createdAt,
          record.acceptedAt ?? null
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async findById(id: string): Promise<CreditSeasonalSchedule | undefined> {
    const result = await this.pool.query<SeasonalScheduleRow>(
      'SELECT * FROM credit.seasonal_schedules WHERE id = $1',
      [id]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<CreditSeasonalSchedule> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException(`Seasonal schedule ${id} not found`);
    }
    return record;
  }

  async find(criteria: SeasonalScheduleCriteria): Promise<CreditSeasonalSchedule[]> {
    const where = this.where(criteria);
    const result = await this.pool.query<SeasonalScheduleRow>(
      `SELECT * FROM credit.seasonal_schedules ${where.where} ORDER BY version, id`,
      where.params
    );
    return result.rows.map(fromRow);
  }

  async updateStatusExpected(
    id: string,
    to: CreditSeasonalScheduleStatus,
    expected: CreditSeasonalScheduleStatus,
    extra: Partial<Pick<CreditSeasonalSchedule, 'acceptedAt'>> = {}
  ): Promise<CreditSeasonalSchedule> {
    let result;
    try {
      result = await this.pool.query<SeasonalScheduleRow>(
        `UPDATE credit.seasonal_schedules
         SET status = $2, accepted_at = $3
         WHERE id = $1 AND status = $4
         RETURNING *`,
        [id, to, extra.acceptedAt ?? null, expected]
      );
    } catch (error) {
      // Unique-violation backstop: another schedule for this loan is
      // already accepted (seasonal_schedules_one_accepted_uq).
      mapPgError(error);
    }
    if (result.rowCount === 0) {
      const current = await this.findById(id);
      if (!current) {
        throw new NotFoundException(`Seasonal schedule ${id} not found`);
      }
      throw new ConflictException(
        `Seasonal schedule ${id} is '${current.status}', expected '${expected}'`
      );
    }
    return fromRow(result.rows[0]);
  }

  private where(criteria: SeasonalScheduleCriteria): WhereClause {
    return composeWhere(eq('loan_id', criteria.loanId), eq('status', criteria.status));
  }
}

export function createPgSeasonalScheduleRepository(pool: pg.Pool): PgSeasonalScheduleRepository {
  return new PgSeasonalScheduleRepository(pool);
}
