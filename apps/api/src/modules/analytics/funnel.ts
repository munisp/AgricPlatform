/**
 * Funnel analytics (M13, Wave P5c). Pure functions over already-loaded
 * records so window math is deterministic and unit-testable.
 *
 * Member funnel: registration → profile-complete → first-course →
 * first-application, computed over the cohort of members who registered
 * inside the configurable trailing window.
 *
 * Chapter-ops funnel: event → RSVP → attendance across chapter events.
 */

/** Matches the shared `profileBadge` 'complete' threshold. */
export const PROFILE_COMPLETE_THRESHOLD = 60;

export interface FunnelStep {
  key: string;
  count: number;
  /** count / previous step count; null for the first step. */
  conversionFromPrevious: number | null;
  /** count / first step count. */
  conversionFromFirst: number;
}

export interface MemberFunnelInput {
  users: ReadonlyArray<{ id: string; createdAt: string }>;
  profiles: ReadonlyArray<{ userId: string; completionScore: number }>;
  enrolments: ReadonlyArray<{ userId: string }>;
  applications: ReadonlyArray<{ userId: string }>;
  /** Trailing window in days; members registered before it are excluded. */
  windowDays: number;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const rate = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 10000) / 10000;

/** Registration → profile-complete → first-course → first-application. */
export function memberFunnel(input: MemberFunnelInput): FunnelStep[] {
  const since = input.now.getTime() - input.windowDays * DAY_MS;
  const cohort = input.users.filter((user) => Date.parse(user.createdAt) >= since);
  const cohortIds = new Set(cohort.map((user) => user.id));

  const profileComplete = new Set(
    input.profiles
      .filter((p) => cohortIds.has(p.userId) && p.completionScore >= PROFILE_COMPLETE_THRESHOLD)
      .map((p) => p.userId)
  );
  const enrolled = new Set(
    input.enrolments.filter((e) => cohortIds.has(e.userId)).map((e) => e.userId)
  );
  const applied = new Set(
    input.applications.filter((a) => cohortIds.has(a.userId)).map((a) => a.userId)
  );

  const counts = [
    ['registered', cohort.length],
    ['profile_complete', profileComplete.size],
    ['first_course', enrolled.size],
    ['first_application', applied.size]
  ] as const;

  const first = counts[0][1];
  return counts.map(([key, count], index) => ({
    key,
    count,
    conversionFromPrevious: index === 0 ? null : rate(count, counts[index - 1][1]),
    conversionFromFirst: rate(count, first)
  }));
}

export interface ChapterOpsFunnel {
  events: number;
  rsvps: number;
  attendances: number;
  /** rsvps / events (0 when no events). */
  rsvpPerEvent: number;
  /** attendances / rsvps (0 when no RSVPs). */
  attendanceRate: number;
}

/** Event → RSVP → attendance funnel for chapter operations. */
export function chapterOpsFunnel(
  events: ReadonlyArray<{ id: string }>,
  rsvps: ReadonlyArray<{ eventId: string; status: 'rsvp' | 'attended' }>
): ChapterOpsFunnel {
  const eventIds = new Set(events.map((event) => event.id));
  const scoped = rsvps.filter((rsvp) => eventIds.has(rsvp.eventId));
  const attendances = scoped.filter((rsvp) => rsvp.status === 'attended').length;
  return {
    events: events.length,
    rsvps: scoped.length,
    attendances,
    rsvpPerEvent: rate(scoped.length, events.length),
    attendanceRate: rate(attendances, scoped.length)
  };
}
