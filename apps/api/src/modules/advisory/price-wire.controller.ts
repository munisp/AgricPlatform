import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  PRICE_WIRE_FLAG,
  PriceWireService,
  WIRE_CADENCES,
  WIRE_CHANNELS,
  type SubscribePriceInput
} from './price-wire.service.js';

class SubscribePriceDto implements SubscribePriceInput {
  @IsString()
  commodity!: string;

  @IsString()
  marketId!: string;

  @IsIn(WIRE_CHANNELS)
  channel!: SubscribePriceInput['channel'];

  @IsOptional()
  @IsIn(WIRE_CADENCES)
  cadence?: SubscribePriceInput['cadence'];
}

/**
 * Price Wire endpoints (Stage 27, innovation 11). Every route is flag-gated
 * behind `price-wire` (fail-closed 404 when off, default OFF) after
 * RolesGuard so the flag guard sees request.user.
 */
@ApiTags('advisory')
@Controller('advisory')
@Authenticated()
@RequiresFeature(PRICE_WIRE_FLAG)
@UseGuards(RolesGuard, FeatureFlagGuard)
export class PriceWireController {
  constructor(private readonly wire: PriceWireService) {}

  @Post('price-subscriptions')
  @ApiOperation({
    summary:
      'Subscribe to crop-price alerts for a commodity at a market ' +
      '(dedupe key user+commodity+market+channel; re-subscribing revives a stopped row)'
  })
  async subscribe(@Body() dto: SubscribePriceDto, @CurrentUser() actor: User | null) {
    return { data: await this.wire.subscribe(actor, dto) };
  }

  @Get('price-subscriptions')
  @ApiOperation({ summary: "List the caller's price subscriptions" })
  async listMine(@CurrentUser() actor: User | null) {
    return { data: await this.wire.listMine(actor) };
  }

  @Delete('price-subscriptions/:id')
  @ApiOperation({ summary: 'Stop a price subscription (owner or admin; replay-safe)' })
  async unsubscribe(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.wire.unsubscribe(actor, id) };
  }

  @Get('price-subscriptions/:id/dispatches')
  @ApiOperation({ summary: 'Dispatch history for a price subscription (owner or admin)' })
  async dispatches(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.wire.dispatches(actor, id) };
  }

  @Post('price-dispatch/run')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Run one price-wire dispatch pass over due subscriptions. An external scheduler ' +
      '(Temporal/cron) should invoke this endpoint periodically; the API starts no timers of its own.'
  })
  async runDispatch(@CurrentUser() actor: User | null) {
    return { data: await this.wire.runDispatch(actor?.id ?? 'price-wire-dispatch') };
  }
}
