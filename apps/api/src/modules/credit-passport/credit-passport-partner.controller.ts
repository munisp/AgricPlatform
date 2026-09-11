import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  PartnerAuthGuard,
  partnerIdentity,
  type PartnerRequestIdentity
} from '../partner-api/partner-auth.guard.js';
import { PartnerScopes } from '../partner-api/partner-scopes.decorator.js';
import {
  CREDIT_PASSPORT_READ_SCOPE,
  CreditPassportService
} from './credit-passport.service.js';

interface PartnerScopedRequest {
  headers: Record<string, string | string[] | undefined>;
  partner?: PartnerRequestIdentity;
}

/**
 * Partner-API credit passport read surface (Stage 27, Innovation 7). Reuses
 * the partner-api API-key / client-credentials guard UNCHANGED (the
 * traceability exporter-surface pattern): no partner-api files are modified.
 * The route is scoped `credit-passport:read`; record-level authorisation is
 * the consent-scoped, expiring disclosure check in the service (NDPA).
 * Flag-gated behind `credit-passport` (fail-closed 404 when off).
 */
@ApiTags('partner-credit-passport')
@Controller('partner/credit-passports')
@RequiresFeature('credit-passport')
@UseGuards(PartnerAuthGuard, FeatureFlagGuard)
export class CreditPassportPartnerController {
  constructor(private readonly passports: CreditPassportService) {}

  @Get(':userId')
  @PartnerScopes(CREDIT_PASSPORT_READ_SCOPE)
  @ApiOperation({
    summary:
      'Read a farmer\'s credit passport. Scope: credit-passport:read. Requires an active, unexpired consent-scoped disclosure naming this partner.'
  })
  async readForPartner(@Param('userId') userId: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.passports.readForPartner(identity, userId) };
  }
}
