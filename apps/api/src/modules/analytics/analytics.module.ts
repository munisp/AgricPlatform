import { Module } from '@nestjs/common';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsDepthService } from './analytics-depth.service.js';
import { AnalyticsService } from './analytics.service.js';

@Module({
  imports: [ProfilesModule, LearningModule, OpportunitiesModule, MarketplaceModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsDepthService]
})
export class AnalyticsModule {}
