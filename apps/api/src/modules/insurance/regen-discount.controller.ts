import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { InsuranceService } from './insurance.service.js';
import { MAX_REGEN_DISCOUNT_BPS } from './premium.js';
import { REGEN_DISCOUNT_FLAG, RegenDiscountService } from './regen-discount.service.js';

class SetRegenRateCardDto {
  /** Bounded discount in basis points of the computed premium (0 disables). */
  @IsInt()
  @Min(0)
  @Max(MAX_REGEN_DISCOUNT_BPS)
  discountBps!: number;
}

function actorOf(user: User | null): User {
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}

/**
 * Stage 27 (Regen Discount, innovation 12): admin rate-card management for
 * the carbon-MRV-verified premium discount, plus the policy discount line
 * with its evidence link. The whole surface ships behind the
 * `regen-discount` feature flag (default OFF → 404).
 */
@ApiTags('insurance')
@Controller('insurance')
export class RegenDiscountController {
  constructor(
    private readonly regen: RegenDiscountService,
    private readonly insurance: InsuranceService
  ) {}

  @Post('rate-card/regen')
  @RequiresFeature(REGEN_DISCOUNT_FLAG)
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Set the regen-discount rate card (admin; flag regen-discount). Bounded 0–5000 bps; ' +
      'appends a new version (append-only, audit-chained) — historical policies keep the version that priced them.'
  })
  async setRateCard(@Body() dto: SetRegenRateCardDto, @CurrentUser() actor: User | null) {
    return { data: await this.regen.setRateCardDiscount(actorOf(actor), dto.discountBps) };
  }

  @Get('rate-card/regen')
  @RequiresFeature(REGEN_DISCOUNT_FLAG)
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({
    summary: 'Current regen-discount rate card + version history (admin/regulator/donor).'
  })
  async getRateCard() {
    const [current, versions] = await Promise.all([
      this.regen.currentRateCard(),
      this.regen.listRateCardVersions()
    ]);
    return { data: { current: current ?? null, versions } };
  }

  @Get('policies/:id/regen-discount')
  @RequiresFeature(REGEN_DISCOUNT_FLAG)
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('farmer', 'admin', 'regulator', 'donor')
  @ApiOperation({
    summary:
      'Regen-discount line for a policy (discount bps/kobo, rate-card version, evidence link + basis badge). ' +
      'Policy holder or authorised reviewer.'
  })
  async getPolicyDiscount(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = actorOf(actor);
    const policy = await this.insurance.getPolicy(id);
    const reviewer = (['admin', 'regulator', 'donor'] as const).some((role) => caller.roles.includes(role));
    if (policy.farmerUserId !== caller.id && !reviewer) {
      throw new ForbiddenException('Only the policy holder or an authorised reviewer may view this discount');
    }
    return { data: await this.regen.getDiscountForPolicy(id) };
  }
}
