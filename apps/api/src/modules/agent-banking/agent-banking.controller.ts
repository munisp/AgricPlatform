import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Post,
  Patch,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { MSISDN_PATTERN, type User } from '@agric-platform/shared';
import {
  assertAtCallbackFreshness,
  assertAtCallbackIp,
  assertAtCallbackToken,
  resolveAtCallbackToken
} from '../../common/auth/at-callback.utils.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  AGENT_STATUSES,
  type AgentStatus,
  type AgentTopUpStatus,
  type AgentTransactionType,
  type AgentVoucherStatus
} from '../../database/repositories/agent-banking.repository.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { AgentBankingService, type ActorRef } from './agent-banking.service.js';
import { AgentUssdService } from './agent-ussd.service.js';

/**
 * L-13 business ceilings (replace @Max(Number.MAX_SAFE_INTEGER) pseudo-caps):
 * farmer-scale agent transactions cap at ₦1m per transaction; float top-ups
 * and configured daily limits cap at ₦10m. The service-side daily-limit and
 * budget checks remain the authoritative controls.
 */
const MAX_AGENT_TRANSACTION_KOBO = 100_000_000; // ₦1,000,000
const MAX_AGENT_FLOAT_KOBO = 1_000_000_000; // ₦10,000,000

class RegisterAgentDto {
  @IsString()
  @MaxLength(100)
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  organisation!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AGENT_FLOAT_KOBO)
  dailyLimitKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_AGENT_FLOAT_KOBO)
  lowFloatThresholdKobo?: number;
}

class SetStatusDto {
  @IsIn(AGENT_STATUSES)
  status!: AgentStatus;
}

class UpdateLimitsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AGENT_FLOAT_KOBO)
  dailyLimitKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_AGENT_FLOAT_KOBO)
  lowFloatThresholdKobo?: number;
}

class TopUpRequestDto {
  @IsInt()
  @Min(1)
  @Max(MAX_AGENT_FLOAT_KOBO)
  amountKobo!: number;

  /** Mandatory client idempotency key — retries replay the original request. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;
}

class RejectTopUpDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

class CashTransactionDto {
  @IsString()
  @MaxLength(100)
  farmerId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_AGENT_TRANSACTION_KOBO)
  amountKobo!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  otp!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;
}

class IssueVoucherDto {
  @IsString()
  @MaxLength(100)
  farmerId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_AGENT_TRANSACTION_KOBO)
  amountKobo!: number;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  /**
   * Mandatory client idempotency key (stage 22, audit C2-10) — a keyless
   * retry would duplicate a signed money-bearing voucher, so new issuance
   * requests without a key are rejected with 400. NULL keys remain only on
   * rows predating this requirement.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;
}

class RedeemVoucherDto {
  /** The HMAC signature printed on the voucher (optional on the USSD path). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  signature?: string;
}

class InteropQuoteDto {
  @IsInt()
  @Min(1)
  @Max(100_000_000) // ₦100m sanity ceiling on a quote (no money moves here)
  amountNaira!: number;

  @Matches(MSISDN_PATTERN, { message: 'payerMsisdn must be an E.164-ish MSISDN (7–15 digits)' })
  payerMsisdn!: string;

  @Matches(MSISDN_PATTERN, { message: 'payeeMsisdn must be an E.164-ish MSISDN (7–15 digits)' })
  payeeMsisdn!: string;

  @IsString()
  @MaxLength(100)
  reference!: string;
}

class AgentUssdCallbackDto {
  @IsString()
  @MaxLength(100)
  sessionId!: string;

  @IsString()
  @MaxLength(20)
  phoneNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  text?: string;
}

function actorOf(user: User | null): ActorRef {
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return { id: user.id, roles: user.roles };
}

/**
 * Agent banking API (wave AGENTBANK). Role model: admins register and
 * govern agents and decide/settle top-ups; agents (role 'agent') run their
 * own float, cash-in/out and vouchers; farmers self-serve their own
 * transaction history and voucher redemption.
 */
@ApiTags('agent-banking')
@Controller('agent-banking')
export class AgentBankingController {
  constructor(
    private readonly banking: AgentBankingService,
    private readonly metrics: MetricsService
  ) {}

  // ------------------------------------------------------------ agents

  @Post('agents')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Register a banking agent (admin; links user + organisation)' })
  async register(@Body() dto: RegisterAgentDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.registerAgent(dto, actorOf(actor).id) };
  }

  @Get('agents')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List banking agents, optionally by status (admin)' })
  async list(@Query('status') status?: AgentStatus) {
    return { data: await this.banking.listAgents(status) };
  }

  @Get('agents/me')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Own agent profile (agent self-service)' })
  async me(@CurrentUser() actor: User | null) {
    return { data: await this.banking.agentForUser(actorOf(actor).id) };
  }

  @Get('agents/:id')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Agent detail (agent owner or admin)' })
  async detail(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return { data: agent };
  }

  @Patch('agents/:id/status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Advance agent status PENDING→ACTIVE→SUSPENDED (admin)' })
  async setStatus(@Param('id') id: string, @Body() dto: SetStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.setAgentStatus(id, dto.status, actorOf(actor).id) };
  }

  @Patch('agents/:id/limits')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Update daily limit / low-float threshold (admin)' })
  async setLimits(@Param('id') id: string, @Body() dto: UpdateLimitsDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.updateLimits(id, dto, actorOf(actor).id) };
  }

  // ------------------------------------------------------------- float

  @Get('agents/:id/float')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Float balance from the ledger + low-float flag (agent owner or admin)' })
  async float(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return { data: await this.banking.floatBalance(id) };
  }

  @Post('agents/:id/top-ups')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Request a float top-up (agent owner or admin)' })
  async requestTopUp(@Param('id') id: string, @Body() dto: TopUpRequestDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.requestTopUp(id, dto, actorOf(actor)) };
  }

  @Get('top-ups')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Float top-up approval queue (admin/supervisor)' })
  async topUps(@Query('status') status?: AgentTopUpStatus, @Query('agentId') agentId?: string) {
    return { data: await this.banking.listTopUps({ status, agentId }) };
  }

  @Get('agents/:id/top-ups')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Own top-up history (agent owner or admin)' })
  async ownTopUps(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return { data: await this.banking.listTopUps({ agentId: id }) };
  }

  @Post('top-ups/:id/approve')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Approve a REQUESTED top-up (admin)' })
  async approveTopUp(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.banking.decideTopUp(id, 'approve', actorOf(actor).id) };
  }

  @Post('top-ups/:id/reject')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Reject a REQUESTED top-up with a reason (admin)' })
  async rejectTopUp(@Param('id') id: string, @Body() dto: RejectTopUpDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.decideTopUp(id, 'reject', actorOf(actor).id, dto.reason) };
  }

  @Post('top-ups/:id/settle')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Settle an APPROVED top-up — posts the ledger entry (admin)' })
  async settleTopUp(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.banking.settleTopUp(id, actorOf(actor).id) };
  }

  // ------------------------------------------------------- cash-in / out

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('agents/:id/cash-in')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Farmer cash-in at the agent (ledger double-entry, OTP proof, idempotent)' })
  async cashIn(@Param('id') id: string, @Body() dto: CashTransactionDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.cashIn(id, dto, actorOf(actor)) };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('agents/:id/cash-out')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Farmer cash-out at the agent (ledger double-entry, OTP proof, idempotent)' })
  async cashOut(@Param('id') id: string, @Body() dto: CashTransactionDto, @CurrentUser() actor: User | null) {
    const caller = actorOf(actor);
    // V-78: payout outcome counter (agric_agent_payouts_total{result}) so a
    // payout stall/failure storm is visible to Prometheus alerts.
    try {
      const data = await this.banking.cashOut(id, dto, caller);
      this.metrics.agentPayout('success');
      return { data };
    } catch (error) {
      this.metrics.agentPayout('failure');
      throw error;
    }
  }

  @Get('agents/:id/transactions')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Agent transaction log with filters (agent owner or admin)' })
  async transactions(
    @Param('id') id: string,
    @CurrentUser() actor: User | null,
    @Query('type') type?: AgentTransactionType,
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return { data: await this.banking.listTransactions({ agentId: id, type, from, to }) };
  }

  @Get('farmers/me/transactions')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'admin')
  @ApiOperation({ summary: 'Own agent-banking transaction history (farmer self-service)' })
  async farmerTransactions(@CurrentUser() actor: User | null) {
    return { data: await this.banking.listTransactions({ farmerId: actorOf(actor).id }) };
  }

  // ----------------------------------------------------------- vouchers

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('agents/:id/vouchers')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Issue a signed offline voucher (agent owner or admin)' })
  async issueVoucher(@Param('id') id: string, @Body() dto: IssueVoucherDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.issueVoucher(id, dto, actorOf(actor)) };
  }

  @Get('agents/:id/vouchers')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'List vouchers issued by an agent (agent owner or admin)' })
  async vouchers(@Param('id') id: string, @CurrentUser() actor: User | null, @Query('status') status?: string) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return {
      data: await this.banking.listVouchers({
        agentId: id,
        status: status as AgentVoucherStatus | undefined
      })
    };
  }

  @Get('vouchers/:id')
  @UseGuards(RolesGuard)
  @Roles('agent', 'farmer', 'admin')
  @ApiOperation({ summary: 'Voucher detail (farmer, issuing agent or admin)' })
  async voucher(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const voucher = await this.banking.getVoucher(id);
    const agent = await this.banking.getAgent(voucher.agentId);
    const caller = actorOf(actor);
    if (!caller.roles.includes('admin') && caller.id !== voucher.farmerId && caller.id !== agent.userId) {
      throw new UnauthorizedException('Not authorised to view this voucher');
    }
    return { data: voucher };
  }

  @Post('vouchers/:id/redeem')
  @UseGuards(RolesGuard)
  @Roles('agent', 'farmer', 'admin')
  @ApiOperation({ summary: 'Redeem a signed voucher exactly once (replay → 409)' })
  async redeemVoucher(@Param('id') id: string, @Body() dto: RedeemVoucherDto, @CurrentUser() actor: User | null) {
    return { data: await this.banking.redeemVoucher(id, dto.signature, actorOf(actor)) };
  }

  @Post('vouchers/:id/void')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Void an ISSUED voucher (issuing agent or admin)' })
  async voidVoucher(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.banking.voidVoucher(id, actorOf(actor)) };
  }

  // ---------------------------------------------- commissions & reports

  @Get('agents/:id/commissions')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Monthly commission statement (agent owner or admin)' })
  async commissions(@Param('id') id: string, @Query('month') month: string | undefined, @CurrentUser() actor: User | null) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return { data: await this.banking.commissionStatement(id, month ?? new Date().toISOString().slice(0, 7)) };
  }

  @Get('agents/:id/reconciliation')
  @UseGuards(RolesGuard)
  @Roles('agent', 'admin')
  @ApiOperation({ summary: 'Daily reconciliation derived from the ledger (exportable JSON)' })
  async reconciliation(@Param('id') id: string, @Query('date') date: string | undefined, @CurrentUser() actor: User | null) {
    const agent = await this.banking.getAgent(id);
    this.banking.assertAgentAccess(agent, actorOf(actor));
    return { data: await this.banking.reconciliation(id, date ?? new Date().toISOString().slice(0, 10)) };
  }

  // ------------------------------------------- interop (stub/simulator)

  @Get('interop/status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Mojaloop interop adapter status — stub/simulator only (admin)' })
  async interopStatus() {
    return { data: await this.banking.interopStatus() };
  }

  @Post('interop/quote')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Interop quote via the Mojaloop adapter (stub/simulator only, labelled)' })
  async interopQuote(@Body() dto: InteropQuoteDto) {
    return { data: await this.banking.interopQuote(dto) };
  }
}

/**
 * Agent-banking USSD callback (wave AGENTBANK). Mirrors the agronomy USSD
 * channel: fail-closed unless USSD_DRIVER=live|sandbox with AT credentials.
 * AT does not sign callbacks, so authenticity rides on the shared
 * AT_CALLBACK_TOKEN secret (query param on the configured callback URL or
 * x-at-callback-token header, audit C2-3) plus the optional
 * AT_CALLBACK_IP_ALLOWLIST. This channel treats the caller's phone number as
 * the agent's identity, so the token gate is load-bearing.
 */
@ApiTags('agent-banking')
@Controller('agent-banking/ussd')
export class AgentUssdController {
  constructor(private readonly ussd: AgentUssdService) {}

  @Post('callback')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Africa's Talking agent-banking USSD callback (CON/END plain text, ≤182 chars). " +
      'Disabled unless USSD_DRIVER=live|sandbox with AT_API_KEY and AT_USERNAME. ' +
      'Requires the AT_CALLBACK_TOKEN secret (?token= or x-at-callback-token) once configured.'
  })
  async callback(
    @Body() dto: AgentUssdCallbackDto,
    @Query('token') token?: string,
    @Headers('x-at-callback-token') headerToken?: string,
    @Headers('x-at-callback-timestamp') timestamp?: string,
    @Headers('x-at-callback-nonce') nonce?: string,
    @Ip() ip?: string
  ): Promise<string> {
    if (!this.ussd.driverConfig.enabled) {
      throw new NotFoundException(
        'Agent-banking USSD callback is disabled. Set USSD_DRIVER=live|sandbox with AT_API_KEY and AT_USERNAME.'
      );
    }
    // V-19: callback parity with the USSD/IVR channels — header-only token
    // in production plus per-request freshness (timestamp + nonce).
    assertAtCallbackToken(resolveAtCallbackToken(token, headerToken));
    assertAtCallbackFreshness({ timestamp, nonce });
    assertAtCallbackIp(ip);
    return this.ussd.handleCallback({
      sessionId: dto.sessionId,
      phoneNumber: dto.phoneNumber,
      text: dto.text ?? ''
    });
  }
}
