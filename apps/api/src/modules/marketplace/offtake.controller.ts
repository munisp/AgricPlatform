import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { OFFTAKE_FLAG, type OfftakePriceBand } from './offtake.js';
import {
  OfftakeService,
  type CreateOfftakeContractInput,
  type RecordDeliveryInput
} from './offtake.service.js';

class PriceBandDto implements OfftakePriceBand {
  @IsInt()
  @Min(1)
  floorKoboPerKg!: number;

  @IsInt()
  @Min(1)
  capKoboPerKg!: number;
}

class MilestonePlanDto {
  @IsInt()
  @Min(1)
  seq!: number;

  /** ISO calendar date (yyyy-mm-dd) inside the contract window. */
  @IsString()
  @MaxLength(500)
  dueDate!: string;

  @IsInt()
  @Min(1)
  qtyKg!: number;
}

class CreateOfftakeContractDto implements CreateOfftakeContractInput {
  @IsString()
  @MaxLength(100)
  cooperativeId!: string;

  @IsString()
  @MaxLength(100)
  buyerOrgId!: string;

  @IsString()
  @MaxLength(500)
  commodity!: string;

  @IsInt()
  @Min(1)
  qtyKg!: number;

  @IsOptional()
  @IsObject()
  qualitySpec?: Record<string, unknown>;

  @ValidateNested()
  @Type(() => PriceBandDto)
  priceBand!: PriceBandDto;

  @IsString()
  @MaxLength(500)
  windowStart!: string;

  @IsString()
  @MaxLength(500)
  windowEnd!: string;

  @ValidateNested({ each: true })
  @Type(() => MilestonePlanDto)
  @ArrayMinSize(1)
  milestones!: MilestonePlanDto[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}

class RecordDeliveryDto implements RecordDeliveryInput {
  @IsInt()
  @Min(1)
  milestoneSeq!: number;

  /** Traceability lot id — mandatory delivery evidence. */
  @IsString()
  @MaxLength(100)
  lotId!: string;

  @IsInt()
  @Min(1)
  qtyKg!: number;

  @IsInt()
  @Min(1)
  priceKoboPerKg!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  depositReference?: string;
}

/**
 * Harvest Forward Contracts (Stage 27 Batch 3, Innovation 18). Flag-gated
 * behind `offtake-contracts` (default OFF — fail-closed 404 while disabled).
 *
 * Roles: the cooperative persona maps to `chapter_lead` (chapters are the
 * platform's cooperative model; the acting chapter_lead's user id IS the
 * cooperativeId, same mapping as coop-pool listings), the aggregator/off-
 * taker persona maps to `buyer` (the buyerOrgId identity countersigns and
 * funds deliveries). The service re-checks party scoping on every call and
 * answers 404 — not 403 — to non-parties (no existence leak).
 */
@ApiTags('marketplace')
@Controller('marketplace/offtake-contracts')
@RequiresFeature(OFFTAKE_FLAG)
@UseGuards(RolesGuard, FeatureFlagGuard)
export class OfftakeController {
  constructor(private readonly offtake: OfftakeService) {}

  @Post()
  @Roles('chapter_lead', 'buyer', 'admin')
  @ApiOperation({
    summary: 'Draft a harvest forward contract (volume/quality/price-band + milestone plan)'
  })
  async create(@Body() dto: CreateOfftakeContractDto, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.createContract(actor as User, dto) };
  }

  @Post(':id/accept')
  @Roles('buyer', 'admin')
  @ApiOperation({
    summary:
      'Buyer countersign: draft -> active with a guarded CAS (exactly one accept; concurrent accepts lose with 409)'
  })
  async accept(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.accept(actor as User, id) };
  }

  @Post(':id/deliveries')
  @Roles('chapter_lead', 'admin')
  @ApiOperation({
    summary:
      'Record a delivery: traceability lot -> milestone -> auto-invoice -> escrow hold in one saga; price outside the band refuses with a renegotiation event'
  })
  async deliver(
    @Param('id') id: string,
    @Body() dto: RecordDeliveryDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.offtake.recordDelivery(actor as User, id, dto) };
  }

  @Get(':id')
  @Authenticated()
  @ApiOperation({ summary: "Both parties' contract view: terms, milestone progress, deliveries" })
  async view(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.getContract(actor as User, id) };
  }

  @Post('sweep')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Missed/defaulted sweep: milestones past due_date become missed; contracts past their window default (guarded CAS, idempotent)'
  })
  async sweep(@CurrentUser() actor: User | null) {
    return { data: await this.offtake.sweep(actor as User) };
  }

  @Post('settlement-sweep')
  @Roles('admin')
  @ApiOperation({
    summary:
      'V-51 durable settlement retry: re-drives the offtake-settle journal for every released escrow that is missing it (idempotent — identical journal, never duplicate legs)'
  })
  async settlementSweep(@CurrentUser() actor: User | null) {
    return { data: await this.offtake.settlementSweep(actor as User) };
  }
}

/**
 * Credit-side read (Innovation 18): a signed forward is underwriting
 * collateral for SeasonSync/loan decisions — read-only, behind the same
 * `offtake-contracts` flag. Kept in the marketplace module so the credit
 * suite needs no new imports; the route lives under
 * /credit/offtake-collateral per the spec.
 *
 * V-61: restricted to the contract parties + admin + regulator (the
 * service re-checks party scoping). Lender reads need a contract↔lender
 * linkage that does not exist yet — deferred to the V-31 design item, so
 * lenders are 403 until then.
 */
@ApiTags('credit')
@Controller('credit/offtake-collateral')
@RequiresFeature(OFFTAKE_FLAG)
@UseGuards(RolesGuard, FeatureFlagGuard)
export class OfftakeCollateralController {
  constructor(private readonly offtake: OfftakeService) {}

  @Get(':contractId')
  @Roles('chapter_lead', 'buyer', 'admin', 'regulator')
  @ApiOperation({
    summary:
      'Read-only offtake collateral view (delivery/escrow progress) — contract parties, admin and regulator only (V-61; lender reads deferred to V-31)'
  })
  async collateral(@Param('contractId') contractId: string, @CurrentUser() actor: User | null) {
    return { data: await this.offtake.collateralView(actor as User, contractId) };
  }
}
