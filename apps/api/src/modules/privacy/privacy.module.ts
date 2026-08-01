import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { PrivacyController } from './privacy.controller.js';
import { PrivacyService } from './privacy.service.js';

@Module({
  imports: [
    ProfilesModule,
    LearningModule,
    OpportunitiesModule,
    MarketplaceModule,
    FinanceModule,
    NotificationsModule
  ],
  controllers: [PrivacyController],
  providers: [PrivacyService]
})
export class PrivacyModule {}
