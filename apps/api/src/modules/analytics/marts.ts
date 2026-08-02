/**
 * KPI data marts + ETL snapshot support (M13, Wave P5c). This is the
 * lakehouse handoff layer: deterministic daily snapshots computed from the
 * operational repositories, stored in `analytics_marts` (migration 009),
 * and exported as columnar-friendly CSV.
 *
 * Parquet-ready schemas (one row per snapshot_date per mart; snapshot_date
 * is the natural partition key, Africa/Lagos calendar day):
 *
 *   mart_member_kpis_daily
 *     snapshot_date DATE          Lagos calendar day the snapshot describes
 *     total_members INT           cumulative registered members
 *     new_members INT             members registered on snapshot_date
 *     active_members INT          members with last_active_at on snapshot_date
 *     verified_members INT        cumulative verified members
 *     complete_profiles INT       cumulative profiles scoring >= 60 ('complete')
 *     avg_profile_completion DOUBLE mean profile completion score (2dp)
 *
 *   mart_marketplace_daily
 *     snapshot_date DATE
 *     active_listings INT         listings live at snapshot time
 *     total_orders INT            cumulative orders
 *     new_orders INT              orders created on snapshot_date
 *     gmv_naira DOUBLE            sum of order totals created on snapshot_date
 *
 *   mart_learning_daily
 *     snapshot_date DATE
 *     total_courses INT           published courses at snapshot time
 *     total_enrolments INT        cumulative enrolments
 *     new_enrolments INT          enrolments started on snapshot_date
 *     completions INT             enrolments completed on snapshot_date
 *     completion_rate DOUBLE      cumulative completions / enrolments (4dp)
 *
 * The compute functions are pure: callers inject the operational records and
 * the Lagos date key, so snapshot math is unit-testable and re-runnable.
 */

import { PROFILE_COMPLETE_THRESHOLD } from './funnel.js';
import { lagosDayRange } from './retention.js';
import { toCsv, type CsvRow } from './export-formats.js';

export const MART_NAMES = ['member_kpis', 'marketplace', 'learning'] as const;
export type MartName = (typeof MART_NAMES)[number];

export interface MartMemberKpisDaily {
  snapshotDate: string;
  totalMembers: number;
  newMembers: number;
  activeMembers: number;
  verifiedMembers: number;
  completeProfiles: number;
  avgProfileCompletion: number;
}

export interface MartMarketplaceDaily {
  snapshotDate: string;
  activeListings: number;
  totalOrders: number;
  newOrders: number;
  gmvNaira: number;
}

export interface MartLearningDaily {
  snapshotDate: string;
  totalCourses: number;
  totalEnrolments: number;
  newEnrolments: number;
  completions: number;
  completionRate: number;
}

export interface MemberKpisSource {
  users: ReadonlyArray<{ id: string; createdAt: string; lastActiveAt?: string; isVerified: boolean }>;
  profiles: ReadonlyArray<{ userId: string; completionScore: number }>;
}

export interface MarketplaceSource {
  listings: ReadonlyArray<{ isActive: boolean }>;
  orders: ReadonlyArray<{ createdAt: string; totalNaira: number }>;
}

export interface LearningSource {
  courses: ReadonlyArray<{ id: string }>;
  enrolments: ReadonlyArray<{ enrolledAt: string; completedAt?: string }>;
}

const inRange = (iso: string | undefined, start: number, end: number): boolean => {
  if (!iso) return false;
  const time = Date.parse(iso);
  return !Number.isNaN(time) && time >= start && time < end;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

export function computeMemberKpis(snapshotDate: string, source: MemberKpisSource): MartMemberKpisDaily {
  const { start, end } = lagosDayRange(snapshotDate);
  const [from, to] = [start.getTime(), end.getTime()];
  const avg =
    source.profiles.length === 0
      ? 0
      : round2(
          source.profiles.reduce((sum, p) => sum + p.completionScore, 0) / source.profiles.length
        );
  return {
    snapshotDate,
    totalMembers: source.users.length,
    newMembers: source.users.filter((u) => inRange(u.createdAt, from, to)).length,
    activeMembers: source.users.filter((u) => inRange(u.lastActiveAt, from, to)).length,
    verifiedMembers: source.users.filter((u) => u.isVerified).length,
    completeProfiles: source.profiles.filter(
      (p) => p.completionScore >= PROFILE_COMPLETE_THRESHOLD
    ).length,
    avgProfileCompletion: avg
  };
}

export function computeMarketplaceDaily(
  snapshotDate: string,
  source: MarketplaceSource
): MartMarketplaceDaily {
  const { start, end } = lagosDayRange(snapshotDate);
  const [from, to] = [start.getTime(), end.getTime()];
  const dayOrders = source.orders.filter((o) => inRange(o.createdAt, from, to));
  return {
    snapshotDate,
    activeListings: source.listings.filter((l) => l.isActive).length,
    totalOrders: source.orders.length,
    newOrders: dayOrders.length,
    gmvNaira: round2(dayOrders.reduce((sum, o) => sum + o.totalNaira, 0))
  };
}

export function computeLearningDaily(snapshotDate: string, source: LearningSource): MartLearningDaily {
  const { start, end } = lagosDayRange(snapshotDate);
  const [from, to] = [start.getTime(), end.getTime()];
  const totalCompletions = source.enrolments.filter((e) => e.completedAt).length;
  return {
    snapshotDate,
    totalCourses: source.courses.length,
    totalEnrolments: source.enrolments.length,
    newEnrolments: source.enrolments.filter((e) => inRange(e.enrolledAt, from, to)).length,
    completions: source.enrolments.filter((e) => inRange(e.completedAt, from, to)).length,
    completionRate:
      source.enrolments.length === 0 ? 0 : round4(totalCompletions / source.enrolments.length)
  };
}

// -- Columnar CSV export ------------------------------------------------------

export const MART_COLUMNS: Record<MartName, readonly string[]> = {
  member_kpis: [
    'snapshot_date',
    'total_members',
    'new_members',
    'active_members',
    'verified_members',
    'complete_profiles',
    'avg_profile_completion'
  ],
  marketplace: [
    'snapshot_date',
    'active_listings',
    'total_orders',
    'new_orders',
    'gmv_naira'
  ],
  learning: [
    'snapshot_date',
    'total_courses',
    'total_enrolments',
    'new_enrolments',
    'completions',
    'completion_rate'
  ]
};

export function memberKpisCsv(rows: readonly MartMemberKpisDaily[]): string {
  const body: CsvRow[] = rows.map((r) => [
    r.snapshotDate,
    r.totalMembers,
    r.newMembers,
    r.activeMembers,
    r.verifiedMembers,
    r.completeProfiles,
    r.avgProfileCompletion
  ]);
  return toCsv([[...MART_COLUMNS.member_kpis], ...body]);
}

export function marketplaceCsv(rows: readonly MartMarketplaceDaily[]): string {
  const body: CsvRow[] = rows.map((r) => [
    r.snapshotDate,
    r.activeListings,
    r.totalOrders,
    r.newOrders,
    r.gmvNaira
  ]);
  return toCsv([[...MART_COLUMNS.marketplace], ...body]);
}

export function learningCsv(rows: readonly MartLearningDaily[]): string {
  const body: CsvRow[] = rows.map((r) => [
    r.snapshotDate,
    r.totalCourses,
    r.totalEnrolments,
    r.newEnrolments,
    r.completions,
    r.completionRate
  ]);
  return toCsv([[...MART_COLUMNS.learning], ...body]);
}
