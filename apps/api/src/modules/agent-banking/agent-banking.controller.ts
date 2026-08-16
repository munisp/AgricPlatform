import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength
} from 'class-validator';
import { AGENT_VOUCHER_EXPIRY_MS } from '@agric-platform/shared';
import { CurrentUser, Public, Roles, type AuthenticatedUser } from '../../auth/index.js';
import {
  AGENT_STATUSES,
  type AgentStatus,
  type AgentTopUpStatus,
  type AgentTransactionType,
  type AgentVoucherStatus
} from '../../database/repositories/agent-banking.repository.js';
import type { AgentBankingService, ActorRef } from './agent-banking.service.js';

class RegisterAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  organisation!: string;

  /** Defaults to the caller's own user id; admin may register on behalf. */
  @IsOptional()
  @IsString()
  userId?: string;
}

class UpdateAgentStatusDto {
  @IsIn([...AGENT_STATUSES])
  status!: AgentStatus;
}

class UpdateLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  dailyLimitKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  lowFloatThresholdKobo?: number;
}

class CashTransactionDto {
  @IsString()
  @IsNotEmpty()
  farmerId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  /**
   * Mandatory client idempotency key — USSD sessions retransmit on network
   * flakes, and a double-posted cash movement is real money.
   */
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

  /** Farmer presence proof: the OTP code the farmer received. */
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(8)
  otp!: string;
}

class TopUpRequestDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  /** Mandatory client idempotency key — retries replay the original request. */
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}

class TopUpDecisionDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class IssueVoucherDto {
  @IsString()
  @IsNotEmpty()
  farmerId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  /** Optional ISO expiry; defaults to now + 72h. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, {
    message: 'expiresAt must be an ISO 8601 datetime'
  })
  expiresAt?: string;

  /**
   * Mandatory client idempotency key (stage 22, audit C2-10) — a keyless
   * retry would duplicate a signed money-bearing voucher, so new issuance
   * requests without a key are rejected with 400. NULL keys remain only on
   * rows predating this requirement.
   */
  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}

class RedeemVoucherDto {
  /** Optional on the USSD path (session = possession proof); mandatory over the API. */
  @IsOptional()
  @IsString()
  signature?: string;
}

function actorOf(actor: AuthenticatedUser): ActorRef {
  return { id: actor.id, roles: actor.roles };
}

/** Agent-banking HTTP surface: agent onboarding, float top-ups, offline vouchers. */
@Controller('agent-banking')
export class AgentBankingController {
  constructor(private readonly banking: AgentBankingService) {}

  @Post('agents')
  async register(@Body() dto: RegisterAgentDto, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.registerAgent(dto, actorOf(actor)) };
  }

  @Get('agents')
  @Roles('admin')
  async listAgents(@Query('status') status?: string) {
    return { data: await this.banking.listAgents({ status: status as AgentStatus | undefined }) };
  }

  @Get('agents/:id')
  async getAgent(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.getAgentFor(id, actorOf(actor)) };
  }

  @Patch('agents/:id/status')
  @Roles('admin')
  async setStatus(@Param('id') id: string, @Body() dto: UpdateAgentStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.setAgentStatus(id, dto.status, actorOf(actor).id) };
  }

  @Patch('agents/:id/limits')
  @Roles('admin')
  async setLimits(@Param('id') id: string, @Body() dto: UpdateLimitsDto, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.updateLimits(id, dto, actorOf(actor).id) };
  }

  @Get('agents/:id/float')
  async float(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.floatPosition(id, actorOf(actor)) };
  }

  @Post('agents/:id/float-topups')
  async requestTopUp(@Param('id') id: string, @Body() dto: TopUpRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.requestTopUp(id, dto, actorOf(actor)) };
  }

  @Get('agents/:id/float-topups')
  async listTopUps(
    @Param('id') id: string,
    @Query('status') status: string | undefined,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return {
      data: await this.banking.listTopUps(
        { agentId: id, status: status as AgentTopUpStatus | undefined },
        actorOf(actor)
      )
    };
  }

  @Post('float-topups/:id/decision')
  @Roles('admin')
  async decideTopUp(@Param('id') id: string, @Body() dto: TopUpDecisionDto, @CurrentUser() actor: AuthenticatedUser) {
    return {
      data: await this.banking.decideTopUp(id, dto.approve ? 'approve' : 'reject', actorOf(actor).id, dto.reason)
    };
  }

  @Post('float-topups/:id/settle')
  @Roles('admin')
  async settleTopUp(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.settleTopUp(id, actorOf(actor).id) };
  }

  @Post('agents/:id/vouchers')
  async issueVoucher(@Param('id') id: string, @Body() dto: IssueVoucherDto, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.issueVoucher(id, dto, actorOf(actor)) };
  }

  @Get('agents/:id/vouchers')
  async listVouchers(
    @Param('id') id: string,
    @Query('status') status: string | undefined,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return {
      data: await this.banking.listVouchers({
        agentId: id,
        status: status as AgentVoucherStatus | undefined
      })
    };
  }

  @Post('vouchers/:id/redeem')
  async redeemVoucher(@Param('id') id: string, @Body() dto: RedeemVoucherDto, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.redeemVoucher(id, dto.signature, actorOf(actor)) };
  }

  @Post('vouchers/:id/void')
  async voidVoucher(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.voidVoucher(id, actorOf(actor)) };
  }

  @Get('agents/:id/transactions')
  async listTransactions(
    @Param('id') id: string,
    @Query('type') type: string | undefined,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return {
      data: await this.banking.listTransactions(
        { agentId: id, type: type as AgentTransactionType | undefined },
        actorOf(actor)
      )
    };
  }

  @Get('agents/:id/statement')
  async statement(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return { data: await this.banking.agentStatement(id, actorOf(actor)) };
  }
}
