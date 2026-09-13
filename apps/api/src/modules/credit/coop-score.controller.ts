import { Controller, Get, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { CoopScoreService } from './coop-score.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Cooperative Score endpoints (stage-27 Innovation 14, flag `coop-score`).
 * Institution-level credit readiness (0-1000) for the cooperative itself.
 * Admin, lender and the cooperative lead all see the SAME number with the
 * SAME explainability payload — the role check happens in the service
 * because the cooperative-admin surface is the chapter's leadUserId, not a
 * static role. The recompute POST is idempotent on identical inputs, so an
 * external scheduler can drive it on any cadence (scheduled + on-demand).
 */
@ApiTags('credit')
@Controller('credit/coop-score')
export class CoopScoreController {
  constructor(private readonly coopScore: CoopScoreService) {}

  @Get(':cooperativeId')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Authenticated()
  @RequiresFeature('coop-score')
  @ApiOperation({
    summary:
      'Latest cooperative score with 5-factor explainability (admin|lender|cooperative lead; identical payload per role)'
  })
  async getScore(@Param('cooperativeId') cooperativeId: string, @CurrentUser() actor: User | null) {
    return { data: await this.coopScore.getCoopScore(cooperativeId, requireActor(actor)) };
  }

  @Post(':cooperativeId/recompute')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Authenticated()
  @RequiresFeature('coop-score')
  @ApiOperation({
    summary:
      'Recompute the cooperative score (admin|lender|cooperative lead); idempotent for identical inputs, append-only history'
  })
  async recompute(
    @Param('cooperativeId') cooperativeId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.coopScore.recompute(cooperativeId, requireActor(actor)) };
  }
}
