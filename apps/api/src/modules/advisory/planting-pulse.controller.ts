import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  PLANTING_PULSE_FLAG,
  PlantingPulseService,
  SUBSCRIBABLE_CHANNELS,
  type SubscribeInput
} from './planting-pulse.service.js';

class SubscribeDto implements SubscribeInput {
  @IsString()
  @MaxLength(100)
  plotId!: string;

  @IsIn(SUBSCRIBABLE_CHANNELS)
  channel!: SubscribeInput['channel'];

  @IsString()
  @MaxLength(100)
  crop!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  policyVersion?: string;
}

/**
 * Planting-Window Pulse endpoints (Stage 27 Batch 1, innovation 4). Every
 * route is flag-gated behind `planting-window-pulse` (fail-closed 404 when
 * off, default OFF) after RolesGuard so the flag guard sees request.user.
 */
@ApiTags('advisory')
@Controller('advisory')
@Authenticated()
@RequiresFeature(PLANTING_PULSE_FLAG)
@UseGuards(RolesGuard, FeatureFlagGuard)
export class PlantingPulseController {
  constructor(private readonly pulse: PlantingPulseService) {}

  @Post('subscriptions')
  @ApiOperation({
    summary:
      'Subscribe a plot to planting-window advisories (farmer or assisted agent/enumerator; ' +
      'records NDPA consent)'
  })
  async subscribe(@Body() dto: SubscribeDto, @CurrentUser() actor: User | null) {
    return { data: await this.pulse.subscribe(actor, dto) };
  }

  @Get('subscriptions')
  @ApiOperation({ summary: "List the caller's advisory subscriptions" })
  async listMine(@CurrentUser() actor: User | null) {
    return { data: await this.pulse.listMine(actor) };
  }

  @Delete('subscriptions/:id')
  @ApiOperation({ summary: 'Stop a subscription (owner or admin; replay-safe)' })
  async unsubscribe(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.pulse.unsubscribe(actor, id) };
  }

  @Get('subscriptions/:id/dispatches')
  @ApiOperation({ summary: 'Dispatch history for a subscription (owner or admin)' })
  async dispatches(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.pulse.dispatches(actor, id) };
  }

  @Get('subscriptions/:id/next')
  @ApiOperation({
    summary:
      'Next planting-window advisory for a subscription (fresh live Open-Meteo only; ' +
      '503 in production when the weather feed is unavailable — never a fabricated window)'
  })
  async next(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.pulse.nextFor(actor, id) };
  }

  @Post('dispatch/run')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Run one planting-pulse dispatch pass over due subscriptions. An external scheduler ' +
      '(Temporal/cron) should invoke this endpoint periodically; the API starts no timers of its own.'
  })
  async runDispatch(@CurrentUser() actor: User | null) {
    return { data: await this.pulse.runDispatch(actor?.id ?? 'advisory-dispatch') };
  }
}
