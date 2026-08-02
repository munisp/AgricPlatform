import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Lender, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { CreditService } from './credit.service.js';
import { LoanService } from './loan.service.js';

class CreateLenderDto implements Omit<Lender, 'id' | 'isActive'> {
  @IsString()
  name!: string;

  @IsString()
  product!: string;

  @IsInt()
  @Min(0)
  minTicketKobo!: number;

  @IsInt()
  @Min(0)
  maxTicketKobo!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  minScore!: number;

  @IsString({ each: true })
  @ArrayMinSize(1)
  criteria!: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Versioned credit scoring + lender directory/matching (wave P2a). */
@ApiTags('finance')
@Controller('finance')
export class CreditController {
  constructor(
    private readonly credit: CreditService,
    private readonly loans: LoanService
  ) {}

  @Get('credit-score/:userId')
  @ApiOperation({ summary: 'Versioned credit score recomputed from platform signals' })
  async creditScore(@Param('userId') userId: string) {
    return { data: await this.credit.scoreForUser(userId) };
  }

  @Get('lenders')
  @ApiOperation({ summary: 'Active lender directory' })
  async lenders() {
    return { data: await this.loans.listLenders() };
  }

  @Post('lenders')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Register a lender in the directory (admin)' })
  async createLender(@Body() dto: CreateLenderDto, @CurrentUser() actor: User | null) {
    return { data: await this.loans.createLender(dto, actor?.id ?? 'anonymous') };
  }

  @Get('lenders/match/:userId')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Lenders ranked against the member credit score (own record or admin)' })
  async matchLenders(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.loans.matchLenders(userId) };
  }
}
