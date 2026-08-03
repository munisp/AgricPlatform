import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PartnerAuthGuard } from '../partner-api/partner-auth.guard.js';
import { PartnerScopes } from '../partner-api/partner-scopes.decorator.js';
import { InsuranceService } from './insurance.service.js';

/**
 * Insurer read API (wave-insurance): the underwriter-facing surface on the
 * partner-api pattern. Requires the `insurance:read` scope on a partner
 * OAuth token or developer API key (PartnerAuthGuard enforces scope + rate
 * bucket). Read-only: portfolio aggregates and trigger events with full
 * evidence so the insurer can independently reproduce every evaluation.
 */
@ApiTags('partner-insurance')
@Controller('partner/insurance')
@UseGuards(PartnerAuthGuard)
export class InsurerApiController {
  constructor(private readonly insurance: InsuranceService) {}

  @Get('portfolio')
  @PartnerScopes('insurance:read')
  @ApiOperation({ summary: 'Insurer portfolio aggregates (scope: insurance:read).' })
  async portfolio() {
    return { data: await this.insurance.insurerPortfolio() };
  }

  @Get('trigger-events')
  @PartnerScopes('insurance:read')
  @ApiOperation({
    summary: 'All trigger events with evidence payloads + basis flags (scope: insurance:read).'
  })
  async triggerEvents() {
    return { data: await this.insurance.insurerTriggerEvents() };
  }
}
