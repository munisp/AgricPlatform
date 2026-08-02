import { Module } from '@nestjs/common';
import { LearningModule } from '../learning/learning.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { UssdController } from './ussd.controller.js';
import { UssdService } from './ussd.service.js';

/**
 * USSD channel (wave P5b): feature-phone access to registration, market
 * prices, opportunities and course enrolment via Africa's Talking.
 */
@Module({
  imports: [OpportunitiesModule, LearningModule],
  controllers: [UssdController],
  providers: [UssdService],
  exports: [UssdService]
})
export class UssdModule {}
