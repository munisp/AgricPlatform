import { Controller, Get, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../../common/auth/current-user.decorator.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../../common/auth/roles.guard.js';
import { GeoVerificationService } from './geo-verification.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Geo-verified credit SHADOW endpoints (wave-geocredit). Read-only views
 * over credit.geo_credit_shadow_scores plus the admin batch recompute.
 * These endpoints never influence the live approve/decline path.
 */
@ApiTags('credit')
@Controller('credit')
export class GeoVerificationController {
  constructor(private readonly geoVerification: GeoVerificationService) {}

  @Get('applications/:id/geo-shadow')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({
    summary: 'Shadow-mode geo-verified credit factor for an application (admin|lender). Not used in decisions.'
  })
  async getShadow(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.geoVerification.getShadowScore(id, requireActor(actor)) };
  }

  @Post('geo-shadow/recompute')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Recompute shadow geo factors for open applications (admin); idempotent per application+input-fingerprint'
  })
  async recompute(@CurrentUser() actor: User | null) {
    return { data: await this.geoVerification.recomputeOpenApplications(requireActor(actor)) };
  }
}
