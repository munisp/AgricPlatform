import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { VoiceTellerModule } from '../voice/voice-teller.module.js';
import { IvrController } from './ivr.controller.js';
import { IvrService } from './ivr.service.js';

/**
 * IVR voice channel (wave P6a): feature-phone voice access to commodity
 * prices, crop advisory, registration/enrolment status and agent escalation
 * via Africa's Talking Voice. Stage 27 adds the Voice Teller account menu
 * (flag `voice-teller`, default OFF) via the imported VoiceTellerModule.
 */
@Module({
  imports: [AdvisoryModule, LearningModule, ProfilesModule, VoiceTellerModule],
  controllers: [IvrController],
  providers: [IvrService],
  exports: [IvrService]
})
export class IvrModule {}
