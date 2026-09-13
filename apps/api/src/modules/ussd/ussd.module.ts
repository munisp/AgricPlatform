import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { UssdController } from './ussd.controller.js';
import { UssdService } from './ussd.service.js';

/**
 * USSD channel (wave P5b): feature-phone access to registration, market
 * prices, opportunities and course enrolment via Africa's Talking.
 * Stage 27 (innovation 4) adds the Planting-Window Pulse pull node
 * (AdvisoryModule; no cycle — advisory imports integrations only).
 * Stage 27 (innovation 11) adds the Price Wire pull node (AdvisoryModule;
 * no cycle — advisory imports integrations only).
 */
@Module({
  imports: [OpportunitiesModule, LearningModule, AdvisoryModule],
  controllers: [UssdController],
  providers: [UssdService],
  exports: [UssdService]
})
export class UssdModule {}
