/**
 * Weekly cohort retention (M13, Wave P5c). Deterministic date math in the
 * platform timezone Africa/Lagos (WAT, UTC+1, no DST), weeks start Monday.
 *
 * Cohort: members whose `createdAt` falls inside the same Lagos week.
 * Retention is rolling: a member counts as retained in week offset W when
 * their last activity (`lastActiveAt`, falling back to `createdAt`) is in
 * week ≥ cohort week + W. Week 0 is therefore always 1 for non-empty
 * cohorts. Offsets the cohort has not reached yet are null; the current
 * (partial) week is flagged so consumers can annotate it.
 */

/** Africa/Lagos is UTC+1 year-round (no daylight saving in Nigeria). */
export const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 Africa/Lagos of the week containing `date`, as a UTC instant. */
export function lagosWeekStart(date: Date): Date {
  const shifted = new Date(date.getTime() + LAGOS_OFFSET_MS);
  const day = shifted.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  const mondayLagos = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday
  );
  return new Date(mondayLagos - LAGOS_OFFSET_MS);
}

/** `[start, end)` UTC instants of one Lagos calendar day ('YYYY-MM-DD'). */
export function lagosDayRange(dateKey: string): { start: Date; end: Date } {
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - LAGOS_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** 'YYYY-MM-DD' Lagos calendar date key for an instant. */
export function lagosDateKey(date: Date): string {
  const shifted = new Date(date.getTime() + LAGOS_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole weeks between two week-start instants. */
export function weeksBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / WEEK_MS);
}

export interface RetentionUser {
  id: string;
  createdAt: string;
  lastActiveAt?: string;
}

export interface CohortRetentionRow {
  /** Lagos date key of the cohort's Monday. */
  cohortWeek: string;
  size: number;
  /** Retained fraction per week offset; null for offsets not yet reached. */
  retention: (number | null)[];
  /** Absolute retained member counts per week offset; null mirrors above. */
  retained: (number | null)[];
}

export interface RetentionMatrix {
  timezone: 'Africa/Lagos';
  /** Lagos date key of the current (partial) week's Monday. */
  currentWeek: string;
  maxWeeks: number;
  rows: CohortRetentionRow[];
}

/**
 * Weekly signup → active retention matrix over the trailing `maxWeeks`
 * (plus the current partial week). Cohorts are oldest-first.
 */
export function cohortRetentionMatrix(
  users: readonly RetentionUser[],
  options: { now: Date; maxWeeks: number }
): RetentionMatrix {
  const currentWeekStart = lagosWeekStart(options.now);
  const earliestWeekStart = new Date(currentWeekStart.getTime() - options.maxWeeks * WEEK_MS);

  const cohorts = new Map<number, RetentionUser[]>();
  for (const user of users) {
    const created = Date.parse(user.createdAt);
    if (Number.isNaN(created) || created > options.now.getTime()) continue; // future signups excluded
    const weekStart = lagosWeekStart(new Date(created)).getTime();
    if (weekStart < earliestWeekStart.getTime() || weekStart > currentWeekStart.getTime()) continue;
    const bucket = cohorts.get(weekStart) ?? [];
    bucket.push(user);
    cohorts.set(weekStart, bucket);
  }

  const rows: CohortRetentionRow[] = [...cohorts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekStart, members]) => {
      const ageWeeks = weeksBetween(new Date(weekStart), currentWeekStart);
      const retention: (number | null)[] = [];
      const retained: (number | null)[] = [];
      for (let offset = 0; offset <= ageWeeks; offset += 1) {
        const threshold = weekStart + offset * WEEK_MS;
        const count = members.filter((member) => {
          const active = Date.parse(member.lastActiveAt ?? member.createdAt);
          return active >= threshold;
        }).length;
        retained.push(count);
        retention.push(Math.round((count / members.length) * 10000) / 10000);
      }
      return {
        cohortWeek: lagosDateKey(new Date(weekStart)),
        size: members.length,
        retention,
        retained
      };
    });

  return {
    timezone: 'Africa/Lagos',
    currentWeek: lagosDateKey(currentWeekStart),
    maxWeeks: options.maxWeeks,
    rows
  };
}

/** True when `cohortWeek` + `offset` is the current (still open) week. */
export function isPartialWeek(matrix: RetentionMatrix, cohortWeek: string, offset: number): boolean {
  const [year, month, day] = cohortWeek.split('-').map(Number);
  const weekStart = new Date(Date.UTC(year, month - 1, day) - LAGOS_OFFSET_MS);
  const target = lagosDateKey(new Date(weekStart.getTime() + offset * WEEK_MS));
  return target === matrix.currentWeek;
}
