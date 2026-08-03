import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { GeoIntelService } from './geo-intel.service.js';

function parseCoordinate(raw: string | undefined, name: 'lat' | 'long'): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new BadRequestException(`${name} must be a number`);
  }
  return value;
}

@ApiTags('geo-intel')
@UseGuards(RolesGuard)
@Controller('geo-intel')
export class GeoIntelController {
  constructor(private readonly geoIntel: GeoIntelService) {}

  @Get('flood-risk')
  @Authenticated()
  @ApiOperation({
    summary:
      'Flood-risk assessment for a point (or the caller’s own farm plot). Simulated fixture unless the flood-ml sidecar is enabled.'
  })
  async floodRisk(
    @CurrentUser() actor: User | null,
    @Query('lat') lat?: string,
    @Query('long') long?: string
  ) {
    return {
      data: await this.geoIntel.assessFloodRisk(actor, {
        lat: parseCoordinate(lat, 'lat'),
        long: parseCoordinate(long, 'long')
      })
    };
  }

  @Get('flood-risk/status')
  @Authenticated()
  @ApiOperation({
    summary: 'Honest flood-risk driver status (driver, configured, healthy, liveInference)'
  })
  async floodRiskStatus(@CurrentUser() actor: User | null) {
    return { data: await this.geoIntel.floodRiskStatus(actor) };
  }
}
