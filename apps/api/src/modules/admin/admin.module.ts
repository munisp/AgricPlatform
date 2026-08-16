import { Module } from '@nestjs/common';
import { ChaptersModule } from '../chapters/chapters.module.js';
import { CommunityModule } from '../community/community.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
// Wave COMP (additive): signed audit evidence export.
import { AuditEvidenceController } from './audit-evidence.controller.js';
import { AuditEvidenceService } from './audit-evidence.service.js';

@Module({
  imports: [CommunityModule, ChaptersModule, FinanceModule, LearningModule, MarketplaceModule, OpportunitiesModule, IntegrationsModule],
  controllers: [AdminController, AuditEvidenceController],
  providers: [AdminService, AuditEvidenceService]
})
export class AdminModule {}
