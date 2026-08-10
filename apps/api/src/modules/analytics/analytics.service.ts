import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PlatformMetric, UserRole } from '@agric-platform/shared';
import { USER_ROLES } from '@agric-platform/shared';
import { CREDIT_PROFILE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { CreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { assertNoSeedPlatformMetrics, composePlatformMetrics } from './platform-metrics.js';

export interface AnalyticsOverview {
  users: number;
  courses: number;
  courseCompletions: number;
  activeOpportunities: number;
  applications: number;
  activeListings: number;
}

export interface Segment {
  key: string;
  count: number;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    // Optional so bare service constructions in tests keep working; a missing
    // source degrades its metric to a labelled seed fixture (refused in
    // production) rather than a fabricated live number.
    @Optional() private readonly chapters?: ChaptersService,
    @Optional() @Inject(CREDIT_PROFILE_REPOSITORY) private readonly creditProfiles?: CreditProfileRepository
  ) {}

  /**
   * Platform KPIs computed from repositories (basis 'live'). Metrics without
   * a wired source carry the labelled seed fixture (basis 'seed') and are
   * refused outright in production — no hardcoded numbers served as real.
   */
  async metrics(): Promise<PlatformMetric[]> {
    const [members, chapters, courseCompletions, opportunities, marketplaceListings, creditProfiles] =
      await Promise.all([
        this.users.count(),
        this.chapters?.all(),
        this.learning.completionCount(),
        this.opportunities.list({ active: true, page: 1, pageSize: 1 }),
        this.marketplace.activeListingCount(),
        this.creditProfiles?.count()
      ]);
    const metrics = composePlatformMetrics({
      members,
      activeChapters: chapters?.filter((chapter) => chapter.active).length,
      courseCompletions,
      openOpportunities: opportunities.total,
      marketplaceListings,
      creditProfiles
    });
    assertNoSeedPlatformMetrics(metrics);
    return metrics;
  }

  async overview(): Promise<AnalyticsOverview> {
    const [users, courses, courseCompletions, activeOpportunities, applications, activeListings] =
      await Promise.all([
        this.users.count(),
        this.learning.allCourses(),
        this.learning.completionCount(),
        this.opportunities.list({ active: true, page: 1, pageSize: 1 }),
        this.opportunities.listApplications({}),
        this.marketplace.activeListingCount()
      ]);
    return {
      users,
      courses: courses.length,
      courseCompletions,
      activeOpportunities: activeOpportunities.total,
      applications: applications.length,
      activeListings
    };
  }

  async segments(by: 'state' | 'role'): Promise<Segment[]> {
    if (by === 'role') {
      return Promise.all(
        USER_ROLES.map(async (role: UserRole) => ({
          key: role,
          count: await this.users.countByRole(role)
        }))
      );
    }
    const counts = await this.profiles.countByState();
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** JSON export bundle for reporting pipelines (CSV driver in Phase 2). */
  async export() {
    const [overview, byRole, byState, metrics] = await Promise.all([
      this.overview(),
      this.segments('role'),
      this.segments('state'),
      this.metrics()
    ]);
    return {
      generatedAt: new Date().toISOString(),
      metrics,
      overview,
      byRole,
      byState
    };
  }
}
