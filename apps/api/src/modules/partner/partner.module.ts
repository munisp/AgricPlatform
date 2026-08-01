import { Module } from '@nestjs/common';
import { LearningModule } from '../learning/learning.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { PartnerController } from './partner.controller.js';
import { PartnerService } from './partner.service.js';

@Module({
  imports: [OpportunitiesModule, LearningModule],
  controllers: [PartnerController],
  providers: [PartnerService]
})
export class PartnerModule {}
