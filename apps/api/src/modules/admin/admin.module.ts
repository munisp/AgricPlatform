import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module.js';
import { ChaptersModule } from '../chapters/chapters.module.js';
import { CommunityModule } from '../community/community.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { SweepersModule } from '../sweepers/sweepers.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * Admin module (wave P5d). Imports the domain modules whose services the
 * AdminService facade composes. SweepersModule provides the WP-G12
 * money-state sweepers; PartnerApiModule (OB-17b) provides
 * PartnerAuthService for partner-organisation client provisioning.
 */
@Module({
  imports: [
    CoreModule,
    UsersModule,
    CommunityModule,
    FinanceModule,
    OpportunitiesModule,
    LearningModule,
    MarketplaceModule,
    ChaptersModule,
    IntegrationsModule,
    SweepersModule,
    PartnerApiModule
  ],
  controllers: [AdminController],
  providers: [AdminService]
})
export class AdminModule {}
