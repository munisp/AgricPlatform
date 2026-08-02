import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import {
  ANALYTICS_MART_REPOSITORY,
  APPLICATION_REPOSITORY,
  CHAPTER_EVENT_REPOSITORY,
  COURSE_REPOSITORY,
  ENROLMENT_REPOSITORY,
  EVENT_RSVP_REPOSITORY,
  LISTING_REPOSITORY,
  ORDER_REPOSITORY,
  PROFILE_REPOSITORY,
  USER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AnalyticsMartRepository, MartDateRange } from '../../database/repositories/analytics-mart.repository.js';
import type { ApplicationRepository } from '../../database/repositories/application.repository.js';
import type { ChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import type { CourseRepository } from '../../database/repositories/course.repository.js';
import type { EnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import type { EventRsvpRepository } from '../../database/repositories/event-rsvp.repository.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import { chapterOpsFunnel, memberFunnel, type ChapterOpsFunnel, type FunnelStep } from './funnel.js';
import {
  computeLearningDaily,
  computeMarketplaceDaily,
  computeMemberKpis,
  learningCsv,
  marketplaceCsv,
  memberKpisCsv,
  MART_NAMES,
  type MartLearningDaily,
  type MartMarketplaceDaily,
  type MartMemberKpisDaily,
  type MartName
} from './marts.js';
import { lagosDateKey } from './retention.js';
import { cohortRetentionMatrix, type RetentionMatrix } from './retention.js';
import { segmentCounts, type SegmentDimension, type SegmentationResult } from './segmentation.js';

export const DEFAULT_FUNNEL_WINDOW_DAYS = 90;
export const DEFAULT_RETENTION_WEEKS = 8;

export interface MartSnapshot {
  memberKpis: MartMemberKpisDaily;
  marketplace: MartMarketplaceDaily;
  learning: MartLearningDaily;
}

/**
 * Analytics depth (M13 full, Wave P5c): segmentation, funnels, weekly
 * cohort retention and the lakehouse-ready KPI marts. Reads through the
 * repository ports so the same code serves the in-memory dev runtime and
 * PostgreSQL; all math lives in pure modules beside this service.
 */
@Injectable()
export class AnalyticsDepthService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(ENROLMENT_REPOSITORY) private readonly enrolments: EnrolmentRepository,
    @Inject(APPLICATION_REPOSITORY) private readonly applications: ApplicationRepository,
    @Inject(CHAPTER_EVENT_REPOSITORY) private readonly chapterEvents: ChapterEventRepository,
    @Inject(EVENT_RSVP_REPOSITORY) private readonly eventRsvps: EventRsvpRepository,
    @Inject(COURSE_REPOSITORY) private readonly courses: CourseRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ANALYTICS_MART_REPOSITORY) private readonly marts: AnalyticsMartRepository
  ) {}

  // -- Segmentation -----------------------------------------------------------

  async segment(dimension: SegmentDimension): Promise<SegmentationResult> {
    const [users, profiles] = await Promise.all([this.users.all(), this.profiles.all()]);
    const profileByUser = new Map(profiles.map((profile) => [profile.userId, profile]));
    switch (dimension) {
      case 'state':
        return segmentCounts(
          users,
          (user) => [profileByUser.get(user.id)?.location.state ?? ''],
          'state'
        );
      case 'crop':
        return segmentCounts(
          users,
          (user) => profileByUser.get(user.id)?.farmingInterests ?? [],
          'crop'
        );
      case 'role':
        return segmentCounts(users, (user: User) => user.roles, 'role');
      case 'kyc_tier':
        return segmentCounts(users, (user) => [user.kycTier], 'kyc_tier');
      case 'cohort':
        // Signup month in Africa/Lagos, e.g. '2026-08'.
        return segmentCounts(
          users,
          (user) => [lagosDateKey(new Date(Date.parse(user.createdAt))).slice(0, 7)],
          'cohort'
        );
    }
  }

  // -- Funnels ------------------------------------------------------------------

  async funnel(
    windowDays = DEFAULT_FUNNEL_WINDOW_DAYS,
    now: Date = new Date()
  ): Promise<{ windowDays: number; steps: FunnelStep[] }> {
    const [users, profiles, enrolments, applications] = await Promise.all([
      this.users.all(),
      this.profiles.all(),
      this.enrolments.all(),
      this.applications.all()
    ]);
    return {
      windowDays,
      steps: memberFunnel({ users, profiles, enrolments, applications, windowDays, now })
    };
  }

  async chapterFunnel(): Promise<ChapterOpsFunnel> {
    const [events, rsvps] = await Promise.all([this.chapterEvents.all(), this.eventRsvps.all()]);
    return chapterOpsFunnel(events, rsvps);
  }

  // -- Retention ------------------------------------------------------------------

  async retention(weeks = DEFAULT_RETENTION_WEEKS, now: Date = new Date()): Promise<RetentionMatrix> {
    const users = await this.users.all();
    return cohortRetentionMatrix(users, { now, maxWeeks: weeks });
  }

  // -- KPI data marts -----------------------------------------------------------

  /**
   * ETL snapshot: recomputes all three marts for one Lagos calendar day and
   * upserts them (idempotent per date — safe to re-run for backfills).
   * Returns the persisted rows.
   */
  async snapshotMarts(snapshotDate: string): Promise<MartSnapshot> {
    const [users, profiles, courses, enrolments, listings, orders] = await Promise.all([
      this.users.all(),
      this.profiles.all(),
      this.courses.all(),
      this.enrolments.all(),
      this.listings.all(),
      this.orders.all()
    ]);
    const memberKpis = computeMemberKpis(snapshotDate, { users, profiles });
    const marketplace = computeMarketplaceDaily(snapshotDate, { listings, orders });
    const learning = computeLearningDaily(snapshotDate, { courses, enrolments });
    await Promise.all([
      this.marts.upsertMemberKpis(memberKpis),
      this.marts.upsertMarketplace(marketplace),
      this.marts.upsertLearning(learning)
    ]);
    return { memberKpis, marketplace, learning };
  }

  async martRows(
    mart: MartName,
    range: MartDateRange
  ): Promise<MartMemberKpisDaily[] | MartMarketplaceDaily[] | MartLearningDaily[]> {
    switch (mart) {
      case 'member_kpis':
        return this.marts.memberKpis(range);
      case 'marketplace':
        return this.marts.marketplaceDaily(range);
      case 'learning':
        return this.marts.learningDaily(range);
    }
  }

  /** Columnar-friendly CSV (header + one row per snapshot date). */
  async martCsv(mart: MartName, range: MartDateRange): Promise<string> {
    switch (mart) {
      case 'member_kpis':
        return memberKpisCsv(await this.marts.memberKpis(range));
      case 'marketplace':
        return marketplaceCsv(await this.marts.marketplaceDaily(range));
      case 'learning':
        return learningCsv(await this.marts.learningDaily(range));
    }
  }
}

export { MART_NAMES };
