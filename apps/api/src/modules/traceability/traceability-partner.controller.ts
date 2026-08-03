import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import {
  PartnerAuthGuard,
  partnerIdentity,
  type PartnerRequestIdentity
} from '../partner-api/partner-auth.guard.js';
import { PartnerScopes } from '../partner-api/partner-scopes.decorator.js';
import { TraceabilityService } from './traceability.service.js';

class PartnerCreateShipmentDto {
  @IsArray()
  @IsString({ each: true })
  lotIds!: string[];

  @IsOptional()
  @IsString()
  reference?: string;
}

interface PartnerScopedRequest {
  partner?: PartnerRequestIdentity;
}

/**
 * Exporter/partner traceability surface (wave-eudr). Reuses the partner-api
 * API-key / client-credentials guard unchanged; routes are scoped
 * `traceability:write` (shipment creation) and `traceability:read` (DDS
 * fetch + chain verification). Partners act across many farmers' lots under
 * contract, so record-level authorisation is scope-based and every DDS is
 * confined to shipments the same client created.
 */
@ApiTags('partner-traceability')
@Controller('partner/traceability')
@UseGuards(PartnerAuthGuard)
export class TraceabilityPartnerController {
  constructor(private readonly traceability: TraceabilityService) {}

  @Post('shipments')
  @PartnerScopes('traceability:write')
  @ApiOperation({
    summary: 'Create a shipment from commodity lots (exporter). Scope: traceability:write.'
  })
  async createShipment(
    @Body() dto: PartnerCreateShipmentDto,
    @Req() request: PartnerScopedRequest
  ) {
    const identity = partnerIdentity(request);
    return { data: await this.traceability.createShipmentForPartner(identity.clientId, dto) };
  }

  @Get('shipments/:id/dds')
  @PartnerScopes('traceability:read')
  @ApiOperation({
    summary: 'Fetch the EUDR due-diligence statement JSON for a shipment. Scope: traceability:read.'
  })
  async fetchDds(@Param('id') id: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.traceability.exportDdsForPartner(identity.clientId, id) };
  }

  @Get('shipments/:id/dds/verify')
  @PartnerScopes('traceability:read')
  @ApiOperation({
    summary: 'Recompute the custody hash chain for a shipment. Scope: traceability:read.'
  })
  async verifyDds(@Param('id') id: string, @Req() request: PartnerScopedRequest) {
    const identity = partnerIdentity(request);
    return { data: await this.traceability.verifyShipmentChainForPartner(identity.clientId, id) };
  }
}
