import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './core/core.module.js';
import { HealthController } from './health/health.controller.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AdvisoryModule } from './modules/advisory/advisory.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ChaptersModule } from './modules/chapters/chapters.module.js';
import { CommunityModule } from './modules/community/community.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { FinanceModule } from './modules/finance/finance.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { LearningModule } from './modules/learning/learning.module.js';
import { MarketplaceModule } from './modules/marketplace/marketplace.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OpportunitiesModule } from './modules/opportunities/opportunities.module.js';
import { PartnerModule } from './modules/partner/partner.module.js';
import { PrivacyModule } from './modules/privacy/privacy.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    // In-memory rate limiting (docs/security-compliance.md §7 "SSRF / rate
    // abuse"). TODO(prod): back the store with Redis so limits hold across
    // replicas — tracked in docs/production-readiness.md.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    CoreModule,
    UsersModule,
    AuthModule,
    ProfilesModule,
    DashboardModule,
    LearningModule,
    CommunityModule,
    OpportunitiesModule,
    ChaptersModule,
    AdvisoryModule,
    MarketplaceModule,
    FinanceModule,
    NotificationsModule,
    AdminModule,
    PartnerModule,
    AnalyticsModule,
    PrivacyModule,
    SearchModule,
    IntegrationsModule
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
})
export class AppModule {}
