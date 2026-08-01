import { Injectable } from '@nestjs/common';
import type { PlatformMetric, UserRole } from '@agric-platform/shared';
import { platformMetrics, USER_ROLES } from '@agric-platform/shared';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';

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
    private readonly marketplace: MarketplaceService
  ) {}

  metrics(): PlatformMetric[] {
    return platformMetrics;
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
    const [overview, byRole, byState] = await Promise.all([
      this.overview(),
      this.segments('role'),
      this.segments('state')
    ]);
    return {
      generatedAt: new Date().toISOString(),
      metrics: this.metrics(),
      overview,
      byRole,
      byState
    };
  }
}
