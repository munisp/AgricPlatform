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
import { IsInt, IsNumber, IsString, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  LtvGuardianService,
  type AttachMonitorInput
} from './ltv-guardian.service.js';

/** Rollout flag for the Receipt LTV Guardian surface (default OFF). */
export const WHR_LTV_GUARDIAN_FLAG = 'whr-ltv-guardian';

class AttachMonitorDto implements AttachMonitorInput {
  @IsString()
  loanId!: string;

  @IsNumber()
  @Min(0.01)
  pledgedQtyKg!: number;

  @IsString()
  commodity!: string;

  @IsInt()
  @Min(0)
  @Max(9999)
  haircutBps!: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  ltvLimitBps!: number;

  @IsInt()
  @Min(1)
  @Max(10000)
  marginCallBps!: number;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Receipt LTV Guardian routes (Stage 27 / Innovation 8). The whole surface
 * sits behind the `whr-ltv-guardian` feature flag (default OFF; the guard
 * fails closed with 404 when the flag does not cover the caller).
 */
@ApiTags('warehouse')
@Controller('warehouse')
export class LtvGuardianController {
  constructor(private readonly guardian: LtvGuardianService) {}

  @Post('receipts/:id/monitor')
  @RequiresFeature(WHR_LTV_GUARDIAN_FLAG)
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('lender', 'admin')
  @ApiOperation({
    summary:
      'Attach a pledged receipt to a loan as a monitored collateral position (lender; flag whr-ltv-guardian)'
  })
  async attachMonitor(
    @Param('id') id: string,
    @Body() dto: AttachMonitorDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.guardian.attachMonitor(id, dto, requireActor(actor)) };
  }

  @Get('positions/:id')
  @Authenticated()
  @RequiresFeature(WHR_LTV_GUARDIAN_FLAG)
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({
    summary:
      'Collateral position detail with append-only LTV observation history (lender/borrower/oversight; flag whr-ltv-guardian)'
  })
  async getPosition(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.guardian.getPosition(id, requireActor(actor)) };
  }

  @Post('ltv/run')
  @RequiresFeature(WHR_LTV_GUARDIAN_FLAG)
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Internal cron/Temporal step: evaluate every live collateral position once (admin; flag whr-ltv-guardian)'
  })
  async runEvaluation(@CurrentUser() actor: User | null) {
    return { data: await this.guardian.runEvaluation(requireActor(actor).id) };
  }
}
