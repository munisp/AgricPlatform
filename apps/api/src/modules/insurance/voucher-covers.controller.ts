import { Body, Controller, Get, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { FLOOD_SEVERITY_RANKS, type FloodSeverityRank, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { MAX_SUM_INSURED_KOBO, MIN_SUM_INSURED_KOBO } from './premium.js';
import { VoucherCoversService } from './voucher-covers.service.js';

class DefineRiderDto {
  /** Catalog product code (trigger type source), e.g. 'NG-RAIN-WET-26'. */
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  productCode!: string;

  @IsInt()
  @Min(MIN_SUM_INSURED_KOBO)
  @Max(MAX_SUM_INSURED_KOBO)
  sumInsuredKobo!: number;

  /** Defaults to the catalog product's rate; bounded 1–10000 bps. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  premiumRateBps?: number;

  /** Pricing flood band captured at definition time (default 'none'). */
  @IsOptional()
  @IsIn([...FLOOD_SEVERITY_RANKS])
  floodBand?: FloodSeverityRank;
}

function actorOf(user: User | null): User {
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}

/**
 * Stage 27 (Insurance-in-the-Bag): programme insurance rider management.
 * Sponsors (admins) define the bundled micro-parametric product per subsidy
 * programme; binding then happens atomically at voucher redemption in
 * InputVouchersService. The whole surface ships behind the
 * `voucher-insurance-rider` feature flag (default OFF → 404).
 */
@ApiTags('input-vouchers')
@Controller('input-vouchers/programmes')
export class VoucherRiderController {
  constructor(private readonly covers: VoucherCoversService) {}

  @Post(':id/insurance-rider')
  @RequiresFeature('voucher-insurance-rider')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Define the programme insurance rider (admin; flag voucher-insurance-rider). ' +
      'Deterministic premium preview from the rate card; terms lock once covers bind.'
  })
  async defineRider(@Param('id') id: string, @Body() dto: DefineRiderDto, @CurrentUser() actor: User | null) {
    return { data: await this.covers.defineRider(id, dto, actorOf(actor).id) };
  }

  @Get(':id/insurance-rider')
  @RequiresFeature('voucher-insurance-rider')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'Programme insurance rider detail (admin/regulator/donor)' })
  async getRider(@Param('id') id: string) {
    return { data: await this.covers.getRider(id) };
  }
}

/**
 * Stage 27: voucher-cover status reads. Farmers read their own cover (the
 * USSD surface reuses this same service method); regulators/donors/admins
 * list per programme. Flag-gated like the rider surface.
 */
@ApiTags('insurance')
@Controller('insurance/voucher-covers')
export class VoucherCoversController {
  constructor(private readonly covers: VoucherCoversService) {}

  @Get()
  @RequiresFeature('voucher-insurance-rider')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'List voucher covers, optionally by programme/status (admin/regulator/donor)' })
  async listCovers(
    @Query('programmeId') programmeId?: string,
    @Query('status') status?: 'quoted' | 'bound' | 'expired' | 'triggered' | 'paid'
  ) {
    return { data: await this.covers.listCovers({ programmeId, status }) };
  }

  @Get(':id')
  @RequiresFeature('voucher-insurance-rider')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('farmer', 'admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'Voucher-cover status (covered farmer, admin, regulator, donor)' })
  async getCover(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.covers.getCover(id, actorOf(actor)) };
  }
}
