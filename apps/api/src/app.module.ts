import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { MetricsModule } from './common/metrics/metrics.module.js';
import { CoreModule } from './core/core.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
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
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { PathwaysModule } from './modules/pathways/pathways.module.js';
import { ProgrammesModule } from './modules/programmes/programmes.module.js';
import { ServicesMarketplaceModule } from './modules/services-marketplace/services-marketplace.module.js';
import { UssdModule } from './modules/ussd/ussd.module.js';
import { RedisModule } from './redis/redis.module.js';
// Wave P5d (additive).
import { EmbedModule } from './modules/embed/embed.module.js';
import { PartnerApiModule } from './modules/partner-api/partner-api.module.js';
// Wave P6a (additive).
import { IvrModule } from './modules/ivr/ivr.module.js';
// Wave L1a (additive): ALTP livestock core.
import { LivestockModule } from './modules/livestock/livestock.module.js';
// Wave L1b (additive): ALTP livestock health/traceability.
import { LivestockHealthModule } from './modules/livestock-health/livestock-health.module.js';
// Wave L1c (additive): ALTP trade/finance/compliance.
import { LivestockTradeModule } from './modules/livestock-trade/livestock-trade.module.js';
// Wave P (additive): DB-backed feature flags.
import { FeatureFlagsModule } from './common/feature-flags/feature-flags.module.js';
// Wave P (additive): Redis-backed rate-limit store.
import { RedisThrottlerStorage } from './common/rate-limit/redis-throttler.storage.js';
import { REDIS_CLIENT } from './database/persistence.tokens.js';

@Module({
  imports: [
    // Logging first: every module/service log line flows through pino.
    LoggingModule,
    MetricsModule,
    // Rate limiting (docs/security-compliance.md §7 "SSRF / rate abuse").
    // Wave P: the store is pluggable — Redis when REDIS_URL is configured
    // (limits hold across replicas; ioredis was already a dependency), the
    // built-in in-memory store otherwise (single-instance only).
    ThrottlerModule.forRootAsync({
      inject: [{ token: REDIS_CLIENT, optional: true }],
      useFactory: (redis: import('ioredis').Redis | null) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        ...(redis ? { storage: new RedisThrottlerStorage(redis) } : {})
      })
    }),
    DatabaseModule,
    RedisModule,
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
    IntegrationsModule,
    HealthModule,
    // Engagement wave (P2b) modules — appended to minimise merge conflicts.
    ServicesMarketplaceModule,
    ProgrammesModule,
    PathwaysModule,
    KnowledgeModule,
    // USSD channel + lightweight-channel depth wave (P5b) — appended.
    UssdModule,
    // Wave P5d modules — appended to minimise merge conflicts.
    PartnerApiModule,
    EmbedModule,
    // Wave P6a IVR voice channel — appended to minimise merge conflicts.
    IvrModule,
    // Wave L1a ALTP livestock core — appended to minimise merge conflicts.
    LivestockModule,
    // Wave L1b ALTP livestock health/traceability — appended to minimise merge conflicts.
    LivestockHealthModule,
    // Wave L1c ALTP trade/finance/compliance — appended to minimise merge conflicts.
    LivestockTradeModule,
    // Wave P platform foundation — appended to minimise merge conflicts.
    FeatureFlagsModule
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }
  ]
})
export class AppModule {}
