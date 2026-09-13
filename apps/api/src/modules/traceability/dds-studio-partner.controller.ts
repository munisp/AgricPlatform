import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  PartnerAuthGuard,
  partnerIdentity,
  type PartnerRequestIdentity
} from '../partner-api/partner-auth.guard.js';
import { PartnerScopes } from '../partner-api/partner-scopes.decorator.js';
import { DdsStudioService } from './dds-studio.service.js';

interface PartnerScopedRequest {
  headers: Record<string, string | string[] | undefined>;
  partner?: PartnerRequestIdentity;
}

/**
 * DDS Studio exporter surface (stage 27 innovation 17). Reuses the
 * partner-api guard unchanged — API-key / client-credentials auth, the
 * ADDITIVE `traceability:dds` scope (existing traceability:read/write scopes
 * are untouched), and the per-client rate bucket. Every route is also gated
 * behind the `dds-studio` feature flag (default OFF — fail-closed 404).
 * Packages are confined to the creating client (exporter_partner_id).
 */
@ApiTags('partner-traceability-dds')
@Controller('partner/traceability')
@UseGuards(PartnerAuthGuard, FeatureFlagGuard)
export class DdsStudioPartnerController {
  constructor(private readonly ddsStudio: DdsStudioService) {}

  @Post('shipments/:id/dds')
  @PartnerScopes('traceability:dds')
  @RequiresFeature('dds-studio')
  @ApiOperation({
    summary: 'Create a draft DDS package for a partner shipment. Scope: traceability:dds.'
  })
  async createDraft(@Param('id') id: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.ddsStudio.createDraftForPartner(identity.clientId, id) };
  }

  @Get('dds/:id')
  @PartnerScopes('traceability:dds')
  @RequiresFeature('dds-studio')
  @ApiOperation({ summary: 'Fetch a DDS package with its checklist. Scope: traceability:dds.' })
  async getPackage(@Param('id') id: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.ddsStudio.getPackageForPartner(identity.clientId, id) };
  }

  @Post('dds/:id/validate')
  @PartnerScopes('traceability:dds')
  @RequiresFeature('dds-studio')
  @ApiOperation({
    summary:
      'Run the DDS validation checklist. Scope: traceability:dds. Failures stay draft; never auto-passed.'
  })
  async validate(@Param('id') id: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.ddsStudio.validateForPartner(identity.clientId, id) };
  }

  @Get('dds/:id/export')
  @PartnerScopes('traceability:dds')
  @RequiresFeature('dds-studio')
  @ApiOperation({
    summary:
      'Export the deterministic hash-manifested DDS package (JSON + evidence annex). Scope: traceability:dds.'
  })
  async export(@Param('id') id: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.ddsStudio.exportForPartner(identity.clientId, id) };
  }
}
