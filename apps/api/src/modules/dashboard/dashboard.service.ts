import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PlatformMetric } from '@agric-platform/shared';
import { CREDIT_PROFILE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { CreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import { assertNoSeedPlatformMetrics, composePlatformMetrics } from '../analytics/platform-metrics.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';

export interface DashboardWidget {
  key: string;
  title: string;
  kind: 'metric' | 'list' | 'action';
  data: unknown;
}

export interface DashboardView {
  userId: string;
  roles: string[];
  metrics: PlatformMetric[];
  widgets: DashboardWidget[];
}

/** Role-aware dashboard composition across domain services. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    private readonly notifications: NotificationsService,
    // Optional: a missing KPI source degrades to a labelled seed fixture
    // (refused in production), never a fabricated live number.
    @Optional() private readonly chapters?: ChaptersService,
    @Optional() @Inject(CREDIT_PROFILE_REPOSITORY) private readonly creditProfiles?: CreditProfileRepository
  ) {}

  /** Live platform KPIs (repository-computed; seed fixtures refused in production). */
  private async platformMetrics(): Promise<PlatformMetric[]> {
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

  async dashboardFor(userId: string): Promise<DashboardView> {
    const user = await this.users.getById(userId);
    const [profile, enrolments, applications, purchases, sales, unread, recommended, metrics] =
      await Promise.all([
        this.profiles.get(userId),
        this.learning.enrolmentsForUser(userId),
        this.opportunities.listApplications({ userId }),
        this.marketplace.listOrders({ buyerId: userId }),
        this.marketplace.listOrders({ sellerId: userId }),
        this.notifications.unreadCount(userId),
        user.roles.includes('farmer') || user.roles.includes('student')
          ? this.opportunities.recommendedFor(userId)
          : Promise.resolve([]),
        this.platformMetrics()
      ]);

    const widgets: DashboardWidget[] = [
      {
        key: 'profile_completion',
        title: 'Profile completion',
        kind: 'metric',
        data: { score: profile.completionScore, badges: profile.badges }
      },
      {
        key: 'unread_notifications',
        title: 'Unread notifications',
        kind: 'metric',
        data: { count: unread }
      }
    ];

    if (user.roles.includes('farmer') || user.roles.includes('student')) {
      widgets.push(
        {
          key: 'learning_progress',
          title: 'Learning progress',
          kind: 'list',
          data: enrolments.map((e) => ({
            courseId: e.courseId,
            progressPercent: e.progressPercent,
            status: e.status
          }))
        },
        {
          key: 'recommended_opportunities',
          title: 'Recommended opportunities',
          kind: 'list',
          data: recommended.slice(0, 5)
        },
        {
          key: 'my_applications',
          title: 'My applications',
          kind: 'list',
          data: applications
        }
      );
    }
    if (user.roles.includes('buyer')) {
      widgets.push({
        key: 'my_purchases',
        title: 'My purchases',
        kind: 'list',
        data: purchases
      });
    }
    if (user.roles.includes('farmer') || user.roles.includes('supplier')) {
      widgets.push({
        key: 'my_sales',
        title: 'My sales',
        kind: 'list',
        data: sales
      });
    }
    if (user.roles.includes('chapter_lead') || user.roles.includes('admin')) {
      widgets.push({
        key: 'platform_metrics',
        title: 'Platform metrics',
        kind: 'metric',
        data: metrics
      });
    }

    return { userId, roles: user.roles, metrics, widgets };
  }
}
