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
import { IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import { COOP_POOL_FLAG } from './coop-pool.js';
import {
  CoopPoolService,
  type CreatePoolInput,
  type PledgeInput
} from './coop-pool.service.js';

class PoolLocationDto {
  @IsString()
  state!: string;

  @IsString()
  lga!: string;

  @IsOptional()
  @IsString()
  ward?: string;
}

class CreatePoolDto implements CreatePoolInput {
  @IsString()
  cooperativeId!: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  crop?: string;

  @IsNumber()
  @Min(1)
  unitPriceNaira!: number;

  @ValidateNested()
  @Type(() => PoolLocationDto)
  location!: PoolLocationDto;

  @IsInt()
  @Min(1)
  minPoolQtyKg!: number;
}

class PledgeDto implements PledgeInput {
  @IsString()
  memberUserId!: string;

  @IsInt()
  @Min(1)
  qtyKg!: number;

  @IsString()
  qualityGrade!: string;
}

/**
 * Coop Pool & Split (Stage 27 Batch 1, Innovation 2). Flag-gated behind
 * `coop-pool-listings` (default OFF — fail-closed 404 while disabled).
 *
 * Roles: the platform has no dedicated `cooperative_admin` role; the
 * cooperative persona maps to `chapter_lead` (chapters are the platform's
 * cooperative model), so pool management requires chapter_lead acting as
 * the pool's own cooperativeId, or admin. Settlement is internal/admin —
 * the primary trigger is the escrow RELEASED outbox consumer.
 */
@ApiTags('marketplace')
@Controller('marketplace/pools')
@RequiresFeature(COOP_POOL_FLAG)
@UseGuards(RolesGuard, FeatureFlagGuard)
export class CoopPoolController {
  constructor(private readonly pools: CoopPoolService) {}

  @Post()
  @Roles('chapter_lead', 'admin')
  @ApiOperation({ summary: 'Open a cooperative pool (accepts member pledges until lock)' })
  async createPool(@Body() dto: CreatePoolDto, @CurrentUser() actor: User | null) {
    return { data: await this.pools.createPool(actor as User, dto) };
  }

  @Post(':id/contributions')
  @Roles('chapter_lead', 'admin')
  @ApiOperation({ summary: 'Pledge a member harvest contribution to an open pool' })
  async pledge(@Param('id') id: string, @Body() dto: PledgeDto, @CurrentUser() actor: User | null) {
    return { data: await this.pools.pledge(actor as User, id, dto) };
  }

  @Post(':id/lock')
  @Roles('chapter_lead', 'admin')
  @ApiOperation({
    summary: 'Lock the pool: compute member shares (Σ = 10000 bps) and open the escrow-backed bulk listing'
  })
  async lock(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.pools.lock(actor as User, id) };
  }

  @Post(':id/settle')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Settle a locked pool (internal/admin): splits the RELEASED escrow to member ledger accounts, exactly once; 503 PAYOUT_UNAVAILABLE when the payout rail is stub/unset'
  })
  async settle(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.pools.settle(id, actor?.id ?? 'anonymous') };
  }

  @Get(':id')
  @Authenticated()
  @ApiOperation({ summary: 'Member-visible pool share statement' })
  async statement(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const statement = await this.pools.getStatement(id);
    this.pools.assertStatementAccess(actor, statement);
    return { data: statement };
  }
}
