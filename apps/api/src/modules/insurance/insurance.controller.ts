import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { InsuranceService, type CreatePolicyInput } from './insurance.service.js';

class CreatePolicyDto implements CreatePolicyInput {
  @IsString()
  @MaxLength(100)
  farmerId!: string;

  @IsString()
  @MaxLength(100)
  crop!: string;

  @IsString()
  @MaxLength(100)
  state!: string;

  @IsInt()
  @Min(1)
  sumInsuredKobo!: number;

  @IsInt()
  @Min(0)
  @Max(10_000)
  premiumRateBps!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  season?: string;
}

/**
 * Parametric crop insurance (wave-insurance). Policies are personal
 * financial records: the farmer (or admin) owns the record; the insurer
 * read surface lives on the partner API (insurer-api.controller.ts).
 * Payout evaluation is deterministic and explainable — every trigger
 * carries the evidence payload used to decide it.
 */
@ApiTags('insurance')
@Controller('insurance')
@UseGuards(RolesGuard)
export class InsuranceController {
  constructor(private readonly insurance: InsuranceService) {}

  @Post('policies')
  @Authenticated()
  @ApiOperation({ summary: 'Create a parametric policy (own farmer record or admin)' })
  async createPolicy(@Body() dto: CreatePolicyDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.farmerId);
    return { data: await this.insurance.createPolicy(dto) };
  }

  @Get('policies')
  @Authenticated()
  @ApiOperation({ summary: 'List policies (own records or admin)' })
  async listPolicies(@CurrentUser() actor: User | null, @Param('farmerId') farmerId?: string) {
    if (farmerId) {
      assertSelfOrAdmin(actor, farmerId);
    } else if (!actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing policies across farmers requires the admin role');
    }
    return { data: await this.insurance.listPolicies(farmerId) };
  }

  @Get('policies/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Policy detail with premium computation (owning farmer or admin)' })
  async getPolicy(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const policy = await this.insurance.getPolicy(id);
    assertSelfOrAdmin(actor, policy.farmerId);
    return { data: policy };
  }

  @Post('policies/:id/activate')
  @Roles('admin')
  @ApiOperation({ summary: 'Activate an accepted policy (admin underwriting workflow)' })
  async activate(@Param('id') id: string) {
    return { data: await this.insurance.activate(id) };
  }

  @Post('triggers/evaluate')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Run one parametric trigger evaluation pass over active policies (admin/scheduler; deterministic, evidence-carried)'
  })
  async evaluate() {
    return { data: await this.insurance.evaluateTriggers() };
  }

  @Get('triggers')
  @Roles('admin')
  @ApiOperation({ summary: 'All trigger events with evidence payloads (admin/insurer audit)' })
  async triggers() {
    return { data: await this.insurance.listTriggerEvents() };
  }

  @Post('payouts/:id/settle')
  @Roles('admin')
  @ApiOperation({ summary: 'Settle an approved payout through the finance ledger (admin)' })
  async settle(@Param('id') id: string) {
    return { data: await this.insurance.settlePayout(id) };
  }

  @Get('payouts')
  @Authenticated()
  @ApiOperation({ summary: 'List payouts (own records or admin)' })
  async payouts(@CurrentUser() actor: User | null, @Param('farmerId') farmerId?: string) {
    if (farmerId) {
      assertSelfOrAdmin(actor, farmerId);
    } else if (!actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing payouts across farmers requires the admin role');
    }
    return { data: await this.insurance.listPayouts(farmerId) };
  }
}
