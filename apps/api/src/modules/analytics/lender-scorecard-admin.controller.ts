/**
 * Lender Lens admin surface (Stage 27, innovation #20): publishing immutable
 * scorecard version definitions. Gated by the `lender-lens` feature flag
 * (default OFF) inside the service — fail closed.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { LenderScorecardService } from './lender-scorecard.service.js';

class PublishScorecardVersionDto {
  /** Version string, e.g. '1.0.0' — immutable once published. */
  @IsString()
  @MaxLength(500)
  version!: string;

  /** Definition overrides; omitted fields take the v1 defaults. */
  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

@ApiTags('analytics')
@Controller('analytics/lender-scorecards')
export class LenderScorecardAdminController {
  constructor(private readonly scorecards: LenderScorecardService) {}

  @Post('publish-version')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Publish an immutable lender scorecard version definition (admin). ' +
      'Re-publishing the same version with an identical definition is an ' +
      'idempotent no-op; a divergent definition is rejected 409.'
  })
  async publishVersion(@Body() dto: PublishScorecardVersionDto, @CurrentUser() actor: User | null) {
    return {
      data: await this.scorecards.publishVersion(requireActor(actor), {
        version: dto.version,
        definition: dto.definition ?? {}
      })
    };
  }

  @Get('versions')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List published lender scorecard versions (admin)' })
  async listVersions(@CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    return {
      data: await this.scorecards.listVersions({ userId: user.id, roles: user.roles })
    };
  }

  @Get('benchmarks/:version/:period')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator')
  @ApiOperation({
    summary:
      'Cross-lender benchmark cells for a (version, period) — k-anonymity ' +
      'floor applied, suppressed cells carry valueBps null (admin|regulator)'
  })
  async benchmarks(
    @Param('version') version: string,
    @Param('period') period: string,
    @CurrentUser() actor: User | null
  ) {
    const user = requireActor(actor);
    return {
      data: await this.scorecards.benchmarks(version, period, {
        userId: user.id,
        roles: user.roles
      })
    };
  }
}
