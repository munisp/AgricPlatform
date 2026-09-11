import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { PartnerAuthGuard } from '../partner-api/partner-auth.guard.js';
import { PartnerScopes } from '../partner-api/partner-scopes.decorator.js';
import { CoopScoreService } from './coop-score.service.js';

/**
 * Partner read surface for Cooperative Score (stage-27 Innovation 14),
 * hosted inside the credit module via PartnerApiModule import — the same
 * composition as wave-insurance's insurer API, so partner-api files stay
 * untouched. Reuses the existing lender-adjacent `profile:read` scope (the
 * partner-api "lender credit-check style" read scope). Read-only, and it
 * returns the SAME number + explainability payload the in-app roles see.
 * Partner tokens carry no platform user, so FeatureFlagGuard admits them
 * only once the `coop-score` flag is fully rolled out (percentage 100) —
 * fail-closed by default.
 */
@ApiTags('partner-credit')
@Controller('partner/credit')
@UseGuards(PartnerAuthGuard, FeatureFlagGuard)
export class CoopScorePartnerController {
  constructor(private readonly coopScore: CoopScoreService) {}

  @Get('coop-score/:cooperativeId')
  @PartnerScopes('profile:read')
  @RequiresFeature('coop-score')
  @ApiOperation({
    summary:
      'Latest cooperative score with 5-factor explainability (partner read; scope: profile:read). Identical payload to the in-app GET.'
  })
  async getScore(@Param('cooperativeId') cooperativeId: string) {
    return { data: await this.coopScore.getCoopScoreForPartner(cooperativeId) };
  }
}
