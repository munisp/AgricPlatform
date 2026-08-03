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
import { IsInt, IsString, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { CreditSavingsService } from './savings.service.js';

class TransactDto {
  @IsInt()
  @Min(1)
  amountKobo!: number;

  /** Idempotency key — unique per transaction. */
  @IsString()
  ref!: string;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * VSLA savings: personal accounts (own deposit/withdrawal) and group
 * accounts (leader moves money, members read). All mutations are
 * ref-idempotent with guarded balance updates.
 */
@ApiTags('credit')
@Controller('credit/savings')
export class CreditSavingsController {
  constructor(private readonly savings: CreditSavingsService) {}

  @Get('accounts/mine')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Own savings account (auto-provisioned)' })
  async ownAccount(@CurrentUser() actor: User | null) {
    return { data: await this.savings.getOwnAccount(requireActor(actor)) };
  }

  @Get('accounts/mine/transactions')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Own savings transactions' })
  async ownTransactions(@CurrentUser() actor: User | null) {
    return { data: await this.savings.listOwnTransactions(requireActor(actor)) };
  }

  @Post('accounts/mine/deposits')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Deposit into the own account (ref-idempotent)' })
  async depositOwn(@Body() dto: TransactDto, @CurrentUser() actor: User | null) {
    return { data: await this.savings.depositOwn(requireActor(actor), dto.amountKobo, dto.ref) };
  }

  @Post('accounts/mine/withdrawals')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Withdraw from the own account (ref-idempotent, balance-guarded)' })
  async withdrawOwn(@Body() dto: TransactDto, @CurrentUser() actor: User | null) {
    return { data: await this.savings.withdrawOwn(requireActor(actor), dto.amountKobo, dto.ref) };
  }

  @Get('groups/:groupId')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Group savings account (members; auto-provisioned)' })
  async groupAccount(@Param('groupId') groupId: string, @CurrentUser() actor: User | null) {
    return { data: await this.savings.getGroupAccount(groupId, requireActor(actor)) };
  }

  @Get('groups/:groupId/transactions')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Group savings transactions (members)' })
  async groupTransactions(@Param('groupId') groupId: string, @CurrentUser() actor: User | null) {
    return { data: await this.savings.listGroupTransactions(groupId, requireActor(actor)) };
  }

  @Post('groups/:groupId/deposits')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Group deposit (group leader; ref-idempotent)' })
  async depositGroup(
    @Param('groupId') groupId: string,
    @Body() dto: TransactDto,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.savings.depositGroup(groupId, requireActor(actor), dto.amountKobo, dto.ref)
    };
  }

  @Post('groups/:groupId/withdrawals')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Group withdrawal (group leader; ref-idempotent, balance-guarded)' })
  async withdrawGroup(
    @Param('groupId') groupId: string,
    @Body() dto: TransactDto,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.savings.withdrawGroup(groupId, requireActor(actor), dto.amountKobo, dto.ref)
    };
  }
}
