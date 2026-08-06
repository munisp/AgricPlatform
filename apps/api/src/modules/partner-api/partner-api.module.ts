import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { UsersModule } from '../users/users.module.js';
import { DeveloperKeysController } from './developer-keys.controller.js';
import { PartnerApiController } from './partner-api.controller.js';
import { PartnerApiService } from './partner-api.service.js';
import { PartnerAuthGuard } from './partner-auth.guard.js';
import { PartnerAuthService } from './partner-auth.service.js';
import { PartnerOAuthController } from './partner-oauth.controller.js';
import { PartnerRateService } from './partner-rate.service.js';
import { WebhookDispatchService } from './webhook-dispatch.service.js';

/**
 * Partner API wave P5d: client-credentials OAuth surface, scoped consented
 * reads, disbursement/enrolment writes, developer API keys and HMAC-signed
 * webhook fan-out.
 */
@Module({
  imports: [CoreModule, UsersModule, ProfilesModule, OpportunitiesModule, LearningModule],
  controllers: [PartnerOAuthController, PartnerApiController, DeveloperKeysController],
  providers: [
    PartnerAuthService,
    PartnerAuthGuard,
    PartnerRateService,
    PartnerApiService,
    WebhookDispatchService
  ],
  // Exported so feature modules hosting partner-scoped controllers (e.g.
  // traceability's exporter surface, wave-insurance's insurer read API) can
  // resolve PartnerAuthGuard and its collaborators when the guard is applied
  // outside this module.
  exports: [PartnerAuthGuard, PartnerAuthService, PartnerRateService]
})
export class PartnerApiModule {}
