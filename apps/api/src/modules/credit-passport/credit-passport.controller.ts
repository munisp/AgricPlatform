import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { CreditPassportService } from './credit-passport.service.js';

/**
 * PUBLIC (unauthenticated) credit passport verification — the QR flow
 * (Stage 27, Innovation 7). The HMAC-signed code is verified server-side;
 * forged or unknown codes answer 404 with no oracle on which part failed.
 * The view is redacted (initials-only holder, per-section basis badges, no
 * kobo amounts). Flag-gated behind `credit-passport-public` (fail-closed
 * 404 when off) so the public surface can launch independently of the
 * farmer/partner surfaces.
 */
@ApiTags('credit-passport')
@Controller('credit-passport')
@RequiresFeature('credit-passport-public')
@UseGuards(FeatureFlagGuard)
export class CreditPassportController {
  constructor(private readonly passports: CreditPassportService) {}

  @Get('verify/:code')
  @ApiOperation({
    summary:
      'PUBLIC credit passport verification: HMAC-signed code → redacted view + QR payload. Forged, revoked or superseded codes answer 404.'
  })
  async verifyPublic(@Param('code') code: string) {
    return { data: await this.passports.verifyPublic(code) };
  }
}
