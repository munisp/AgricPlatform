import { Module } from '@nestjs/common';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [ProfilesModule, LearningModule, OpportunitiesModule, MarketplaceModule, NotificationsModule],
  controllers: [DashboardController],
  providers: [DashboardService]
})
export class DashboardModule {}
