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
import { CommerceModule } from './modules/commerce/commerce.module.js';
// Wave COMP (additive): NDPA 2023 compliance tooling.
import { ComplianceModule } from './modules/compliance/compliance.module.js';
// Wave SYNCSRV (additive): record-level offline sync protocol v1.
import { SyncModule } from './modules/sync/sync.module.js';
// Wave FARMS (additive): farms & crop-production.
import { FarmsModule } from './modules/farms/farms.module.js';
// Wave AGENTS (additive): field-agent (enumerator) assignments + capture.
import { FieldAgentsModule } from './modules/field-agents/field-agents.module.js';
// Wave GEO (additive): geospatial pack — H3 indexing, boundaries, contains.
import { GeoModule } from './modules/geo/geo.module.js';
// Wave ML (additive): geo-intel flood-risk (optional flood-ml sidecar).
import { GeoIntelModule } from './modules/geo-intel/geo-intel.module.js';
import { VoiceModule } from './modules/voice/voice.module.js';
// Wave CREDIT (additive): microfinance suite (loans, scoring, VSLA, savings).
import { CreditModule } from './modules/credit/credit.module.js';
import { TraceabilityModule } from './modules/traceability/traceability.module.js';
import { WorkflowsModule } from './modules/finance/workflows/workflows.module.js';
// Wave AGENTBANK (additive): agent banking.
import { AgentBankingModule } from './modules/agent-banking/agent-banking.module.js';
import { MechanizationModule } from './modules/mechanization/mechanization.module.js';
// Wave-INSURANCE (additive): parametric insurance rail.
import { InsuranceModule } from './modules/insurance/insurance.module.js';
// Wave LIVESTOCK-PASSPORT (additive): digital livestock passport.
import { LivestockPassportModule } from './modules/livestock-passport/livestock-passport.module.js';
// Wave NINVOUCHER (additive): NIN-linked input subsidy e-vouchers.
import { InputVouchersModule } from './modules/input-vouchers/input-vouchers.module.js';
// Wave-WAREHOUSE (additive): electronic warehouse receipts (e-WHR).
import { WarehouseModule } from './modules/warehouse/warehouse.module.js';

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
    // Wave M marketplace commerce depth — appended to minimise merge conflicts.
    CommerceModule,
    // Wave P platform foundation — appended to minimise merge conflicts.
    FeatureFlagsModule,
    // Wave COMP NDPA 2023 compliance tooling — appended to minimise merge conflicts.
    ComplianceModule,
    // Wave SYNCSRV record-level offline sync protocol v1 — appended to minimise merge conflicts.
    SyncModule,
    // Wave FARMS farms & crop-production — appended to minimise merge conflicts.
    FarmsModule,
    // Wave AGENTS field-agent (enumerator) capability — appended to minimise merge conflicts.
    FieldAgentsModule,
    // Wave GEO geospatial pack — appended to minimise merge conflicts.
    GeoModule,
    // Wave ML geo-intel flood-risk — appended to minimise merge conflicts.
    GeoIntelModule,
    // Wave CREDIT microfinance suite — appended to minimise merge conflicts.
    CreditModule,
    // Wave FABRIC workflow registrations (loan disbursement port proof) — appended to minimise merge conflicts.
    WorkflowsModule,
    // Wave EUDR traceability passport — appended to minimise merge conflicts.
    TraceabilityModule,
    // Wave VOICE voice agronomist (IVR/USSD RAG advisory + agent escalation) — appended to minimise merge conflicts.
    VoiceModule,
    // Wave AGENTBANK agent banking (float, cash-in/out, signed vouchers) — appended to minimise merge conflicts.
    AgentBankingModule,
    // Wave MECHANIZATION equipment hire marketplace — appended to minimise merge conflicts.
    MechanizationModule,
    // Wave-INSURANCE parametric insurance rail — appended to minimise merge conflicts.
    InsuranceModule,
    // Wave LIVESTOCK-PASSPORT digital livestock passport — appended to minimise merge conflicts.
    LivestockPassportModule,
    // Wave NINVOUCHER input subsidy e-vouchers (NIN-verified, ledger-backed) — appended to minimise merge conflicts.
    InputVouchersModule,
    // Wave-WAREHOUSE electronic warehouse receipts (e-WHR) — appended to minimise merge conflicts.
    WarehouseModule
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }
  ]
})
export class AppModule {}
