import { Module } from '@nestjs/common';
import { CommunityModule } from '../community/community.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [CommunityModule, FinanceModule, LearningModule, MarketplaceModule, OpportunitiesModule],
  controllers: [AdminController],
  providers: [AdminService]
})
export class AdminModule {}
