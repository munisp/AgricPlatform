/**
 * Lender Lens partner surface (Stage 27, innovation #20): standardized
 * portfolio scorecard reads for lender partners. Scope-guarded
 * (`portfolio:read` — additive new scope) with the shared per-client rate
 * bucket (PartnerAuthGuard). The lender tenant is the TOKEN's bound
 * partnerId — unbound credentials (developer API keys, pre-Stage-24
 * clients) are refused, fail closed (Stage 24 audit A2-2 doctrine).
 *
 * The JSON endpoint serves the real stored payload from Postgres; the
 * export endpoint is storage-gated and answers 503 when object storage is
 * not configured (never a fabricated export).
 */
import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { LenderScorecardExportService } from '../analytics/lender-scorecard-export.service.js';
import { LenderScorecardService } from '../analytics/lender-scorecard.service.js';
import {
  PartnerAuthGuard,
  partnerIdentity,
  type PartnerRequestIdentity
} from './partner-auth.guard.js';
import { PartnerScopes } from './partner-scopes.decorator.js';

/** Fail-closed tenant resolution: only bound client-credentials tokens. */
function requireLenderTenant(identity: PartnerRequestIdentity): string {
  if (!identity.partnerId) {
    throw new ForbiddenException(
      'This credential is not bound to a partner organisation; portfolio scorecards require a bound client-credentials token'
    );
  }
  return identity.partnerId;
}

@ApiTags('partner-api')
@Controller('partner/portfolio')
@UseGuards(PartnerAuthGuard)
export class PortfolioScorecardController {
  constructor(
    private readonly scorecards: LenderScorecardService,
    private readonly scorecardExports: LenderScorecardExportService
  ) {}

  @Get('scorecard')
  @PartnerScopes('portfolio:read')
  @ApiOperation({
    summary:
      'Standardized portfolio scorecard (PAR30/60/90 vintages, geo mix bands, ' +
      'product mix — aggregate only, zero farmer PII). Generated immutably on ' +
      'first request per (lender, version, period); carries a stale badge when ' +
      'the analytics projector heartbeat exceeds the version threshold.'
  })
  async scorecard(
    @Query('period') period: string | undefined,
    @Query('version') version: string | undefined,
    @Req() request: Request
  ) {
    const lenderPartnerId = requireLenderTenant(partnerIdentity(request));
    return { data: await this.scorecards.scorecard(lenderPartnerId, period, version) };
  }

  @Get('scorecard/export')
  @PartnerScopes('portfolio:read')
  @ApiOperation({
    summary:
      'Export the scorecard as parquet + manifest to object storage and return ' +
      'SigV4-presigned download URLs (1h). 503 when export storage is not configured.'
  })
  async exportScorecard(
    @Query('period') period: string | undefined,
    @Query('version') version: string | undefined,
    @Req() request: Request
  ) {
    const lenderPartnerId = requireLenderTenant(partnerIdentity(request));
    return { data: await this.scorecardExports.export(lenderPartnerId, period, version) };
  }
}
