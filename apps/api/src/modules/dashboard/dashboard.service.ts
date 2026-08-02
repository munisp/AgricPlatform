import { Injectable } from '@nestjs/common';
import type { PlatformMetric } from '@agric-platform/shared';
import { platformMetrics } from '@agric-platform/shared';
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
    private readonly notifications: NotificationsService
  ) {}

  async dashboardFor(userId: string): Promise<DashboardView> {
    const user = await this.users.getById(userId);
    const [profile, enrolments, applications, purchases, sales, unread, recommended] =
      await Promise.all([
        this.profiles.get(userId),
        this.learning.enrolmentsForUser(userId),
        this.opportunities.listApplications({ userId }),
        this.marketplace.listOrders({ buyerId: userId }),
        this.marketplace.listOrders({ sellerId: userId }),
        this.notifications.unreadCount(userId),
        user.roles.includes('farmer') || user.roles.includes('student')
          ? this.opportunities.recommendedFor(userId)
          : Promise.resolve([])
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
        data: platformMetrics
      });
    }

    return { userId, roles: user.roles, metrics: platformMetrics, widgets };
  }
}
