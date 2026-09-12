import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { VOICE_TELLER_FLAG } from './intent-router.js';
import { VoiceTellerService } from './voice-teller.service.js';

/**
 * Voice Teller admin surface (Stage 27, Innovation 6): the capability
 * catalog — which grammar-slot intents exist, their DTMF keys, locales and
 * the read models backing them. The transactional flow itself runs inside
 * the IVR callback (ivr/call-flow.ts account nodes); there is deliberately
 * NO public HTTP endpoint that answers account intents (voice channel
 * only, PIN-gated per call). Flag-gated, fail-closed 404 when off.
 */
@ApiTags('voice')
@Controller('voice')
@UseGuards(RolesGuard, FeatureFlagGuard)
export class VoiceTellerController {
  constructor(private readonly teller: VoiceTellerService) {}

  @Get('intents/catalog')
  @Roles('admin')
  @RequiresFeature(VOICE_TELLER_FLAG)
  @ApiOperation({
    summary:
      'Voice Teller capability catalog (admin): grammar-slot intents, DTMF map, locales, read models. Read-only account facts only — no free-form generation.'
  })
  async intentsCatalog() {
    return { data: this.teller.catalog(await this.teller.isEnabled()) };
  }
}
