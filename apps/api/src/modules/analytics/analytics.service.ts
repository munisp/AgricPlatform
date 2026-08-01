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

  overview(): AnalyticsOverview {
    return {
      users: this.users.count(),
      courses: this.learning.allCourses().length,
      courseCompletions: this.learning.completionCount(),
      activeOpportunities: this.opportunities.list({ active: true, page: 1, pageSize: 1 }).total,
      applications: this.opportunities.listApplications({}).length,
      activeListings: this.marketplace.activeListingCount()
    };
  }

  segments(by: 'state' | 'role'): Segment[] {
    if (by === 'role') {
      return USER_ROLES.map((role: UserRole) => ({
        key: role,
        count: this.users.countByRole(role)
      }));
    }
    const counts = new Map<string, number>();
    for (const profile of this.profiles.all()) {
      const state = profile.location?.state || 'unknown';
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** JSON export bundle for reporting pipelines (CSV driver in Phase 2). */
  export() {
    return {
      generatedAt: new Date().toISOString(),
      metrics: this.metrics(),
      overview: this.overview(),
      byRole: this.segments('role'),
      byState: this.segments('state')
    };
  }
}
