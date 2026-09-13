import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { DdsStudioService } from './dds-studio.service.js';

/**
 * DDS Studio internal surface (stage 27 innovation 17): assemble a draft DDS
 * package from a shipment, run the pure validation checklist, and export the
 * deterministic hash-manifested package. Every route is gated behind the
 * `dds-studio` feature flag (default OFF — fail-closed 404) AFTER RolesGuard
 * so the flag guard sees the authenticated user; record-level authorisation
 * lives in the service.
 */
@ApiTags('traceability-dds-studio')
@Controller('traceability')
export class DdsStudioController {
  constructor(private readonly ddsStudio: DdsStudioService) {}

  @Post('shipments/:id/dds')
  @Authenticated()
  @RequiresFeature('dds-studio')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({
    summary: 'Create a draft DDS package for a shipment (feature flag dds-studio).'
  })
  async createDraft(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.ddsStudio.createDraftForUser(actor, id) };
  }

  @Get('dds/:id')
  @Authenticated()
  @RequiresFeature('dds-studio')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({ summary: 'Fetch a DDS package with its latest validation checklist.' })
  async getPackage(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.ddsStudio.getPackageForUser(actor, id) };
  }

  @Post('dds/:id/validate')
  @Authenticated()
  @RequiresFeature('dds-studio')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({
    summary:
      'Run the DDS validation checklist (pure engine; failures stay draft with the missing items named — never auto-passed).'
  })
  async validate(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.ddsStudio.validateForUser(actor, id) };
  }

  @Get('dds/:id/export')
  @Authenticated()
  @RequiresFeature('dds-studio')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({
    summary:
      'Export the DDS JSON + evidence annex (hash-manifested, deterministic). Requires a passing validation; exported packages are immutable.'
  })
  async export(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.ddsStudio.exportForUser(actor, id) };
  }
}
