import type pg from 'pg';
import type {
  MartLearningDaily,
  MartMarketplaceDaily,
  MartMemberKpisDaily
} from '../../modules/analytics/marts.js';
import { num } from '../pg/pg-repository.base.js';
import type { AnalyticsMartRepository, MartDateRange } from './analytics-mart.repository.js';

/**
 * PostgreSQL mart repository (Wave P5c). Upserts are keyed on snapshot_date
 * (the PRIMARY KEY of each mart table) so the ETL snapshot is idempotent
 * per date and safe to re-run.
 */
export class PgAnalyticsMartRepository implements AnalyticsMartRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsertMemberKpis(row: MartMemberKpisDaily): Promise<MartMemberKpisDaily> {
    await this.pool.query(
      `INSERT INTO analytics_marts.member_kpis_daily
         (snapshot_date, total_members, new_members, active_members, verified_members, complete_profiles, avg_profile_completion)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         total_members = EXCLUDED.total_members,
         new_members = EXCLUDED.new_members,
         active_members = EXCLUDED.active_members,
         verified_members = EXCLUDED.verified_members,
         complete_profiles = EXCLUDED.complete_profiles,
         avg_profile_completion = EXCLUDED.avg_profile_completion`,
      [
        row.snapshotDate,
        row.totalMembers,
        row.newMembers,
        row.activeMembers,
        row.verifiedMembers,
        row.completeProfiles,
        row.avgProfileCompletion
      ]
    );
    return row;
  }

  async upsertMarketplace(row: MartMarketplaceDaily): Promise<MartMarketplaceDaily> {
    await this.pool.query(
      `INSERT INTO analytics_marts.marketplace_daily
         (snapshot_date, active_listings, total_orders, new_orders, gmv_naira)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         active_listings = EXCLUDED.active_listings,
         total_orders = EXCLUDED.total_orders,
         new_orders = EXCLUDED.new_orders,
         gmv_naira = EXCLUDED.gmv_naira`,
      [row.snapshotDate, row.activeListings, row.totalOrders, row.newOrders, row.gmvNaira]
    );
    return row;
  }

  async upsertLearning(row: MartLearningDaily): Promise<MartLearningDaily> {
    await this.pool.query(
      `INSERT INTO analytics_marts.learning_daily
         (snapshot_date, total_courses, total_enrolments, new_enrolments, completions, completion_rate)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         total_courses = EXCLUDED.total_courses,
         total_enrolments = EXCLUDED.total_enrolments,
         new_enrolments = EXCLUDED.new_enrolments,
         completions = EXCLUDED.completions,
         completion_rate = EXCLUDED.completion_rate`,
      [
        row.snapshotDate,
        row.totalCourses,
        row.totalEnrolments,
        row.newEnrolments,
        row.completions,
        row.completionRate
      ]
    );
    return row;
  }

  async memberKpis(range: MartDateRange = {}): Promise<MartMemberKpisDaily[]> {
    const result = await this.pool.query(
      `SELECT snapshot_date, total_members, new_members, active_members, verified_members, complete_profiles, avg_profile_completion
       FROM analytics_marts.member_kpis_daily
       WHERE ($1::date IS NULL OR snapshot_date >= $1) AND ($2::date IS NULL OR snapshot_date <= $2)
       ORDER BY snapshot_date`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map((row) => ({
      snapshotDate: dateKey(row.snapshot_date),
      totalMembers: num(row.total_members),
      newMembers: num(row.new_members),
      activeMembers: num(row.active_members),
      verifiedMembers: num(row.verified_members),
      completeProfiles: num(row.complete_profiles),
      avgProfileCompletion: num(row.avg_profile_completion)
    }));
  }

  async marketplaceDaily(range: MartDateRange = {}): Promise<MartMarketplaceDaily[]> {
    const result = await this.pool.query(
      `SELECT snapshot_date, active_listings, total_orders, new_orders, gmv_naira
       FROM analytics_marts.marketplace_daily
       WHERE ($1::date IS NULL OR snapshot_date >= $1) AND ($2::date IS NULL OR snapshot_date <= $2)
       ORDER BY snapshot_date`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map((row) => ({
      snapshotDate: dateKey(row.snapshot_date),
      activeListings: num(row.active_listings),
      totalOrders: num(row.total_orders),
      newOrders: num(row.new_orders),
      gmvNaira: num(row.gmv_naira)
    }));
  }

  async learningDaily(range: MartDateRange = {}): Promise<MartLearningDaily[]> {
    const result = await this.pool.query(
      `SELECT snapshot_date, total_courses, total_enrolments, new_enrolments, completions, completion_rate
       FROM analytics_marts.learning_daily
       WHERE ($1::date IS NULL OR snapshot_date >= $1) AND ($2::date IS NULL OR snapshot_date <= $2)
       ORDER BY snapshot_date`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map((row) => ({
      snapshotDate: dateKey(row.snapshot_date),
      totalCourses: num(row.total_courses),
      totalEnrolments: num(row.total_enrolments),
      newEnrolments: num(row.new_enrolments),
      completions: num(row.completions),
      completionRate: num(row.completion_rate)
    }));
  }
}

/** date row value → 'YYYY-MM-DD' (pg returns Date objects for DATE columns). */
function dateKey(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

export function createPgAnalyticsMartRepository(pool: pg.Pool): PgAnalyticsMartRepository {
  return new PgAnalyticsMartRepository(pool);
}
