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

  dashboardFor(userId: string): DashboardView {
    const user = this.users.getById(userId);
    const profile = this.profiles.get(userId);
    const enrolments = this.learning.enrolmentsForUser(userId);
    const applications = this.opportunities.listApplications({ userId });
    const purchases = this.marketplace.listOrders({ buyerId: userId });
    const sales = this.marketplace.listOrders({ sellerId: userId });

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
        data: { count: this.notifications.unreadCount(userId) }
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
          data: this.opportunities.recommendedFor(userId).slice(0, 5)
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
