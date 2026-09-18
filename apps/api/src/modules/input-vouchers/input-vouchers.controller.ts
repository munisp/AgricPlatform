import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, IsArray, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { NIN_PATTERN, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  INPUT_VOUCHER_STATUSES,
  PROGRAMME_STATUSES,
  type InputVoucherStatus,
  type ProgrammeStatus
} from '../../database/repositories/input-vouchers.repository.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { InputVouchersService, type ActorRef } from './input-vouchers.service.js';

/**
 * L-13 business ceilings (replace @Max(Number.MAX_SAFE_INTEGER) pseudo-caps):
 * a single voucher caps at ₦1m; programme budgets/funding cap at ₦1bn. The
 * service-side budget/float checks remain the authoritative controls.
 */
const MAX_VOUCHER_AMOUNT_KOBO = 100_000_000; // ₦1,000,000
const MAX_PROGRAMME_KOBO = 100_000_000_000; // ₦1,000,000,000

class CreateProgrammeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sponsor!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Donor user funding the programme (V-61) — scopes that donor's reads to it. */
  @IsOptional()
  @IsString()
  funderId?: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VOUCHER_AMOUNT_KOBO)
  perFarmerCapKobo!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_PROGRAMME_KOBO)
  budgetKobo!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  eligibleStates?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  eligibleCrops?: string[];
}

class VerifyBeneficiaryDto {
  @IsString()
  @MaxLength(100)
  farmerId!: string;

  /** Plaintext NIN — verified then discarded; only hash + mask persist. */
  @Matches(NIN_PATTERN, { message: 'nin must be exactly 11 digits' })
  nin!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  primaryCrop?: string;
}

class AllocateVoucherDto {
  @IsString()
  @MaxLength(100)
  farmerId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VOUCHER_AMOUNT_KOBO)
  amountKobo!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

class RedeemVoucherDto {
  /** Agro-dealer invoice reference the redemption settles against. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  invoiceRef!: string;

  /**
   * Stage 27 (Insurance-in-the-Bag): the farmer's planted plot the bundled
   * parametric cover attaches to. Required at redemption when the programme
   * has an active insurance rider (422 otherwise); ignored when the
   * `voucher-insurance-rider` flag is off.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  plotId?: string;

  /**
   * W2-C2 (V-32): partial redemption amount. Omit to redeem the full
   * remaining balance; an overshoot of the remaining balance is 422.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VOUCHER_AMOUNT_KOBO)
  amountKobo?: number;
}

class RefundVoucherDto {
  /** Operator reason for the refund (e.g. counterfeit-input discovery). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** V-02: complaint/dispute case this refund resolves (linkage). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  complaintCaseId?: string;
}

class FundProgrammeDto {
  @IsInt()
  @Min(1)
  @Max(MAX_PROGRAMME_KOBO)
  amountKobo!: number;

  /** Mandatory client idempotency key — top-up retries replay, never double-fund. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;

  /** Optional sponsor/disbursement reference for the audit trail. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;
}

function actorOf(user: User | null): ActorRef {
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return { id: user.id, roles: user.roles };
}

/**
 * Input-subsidy e-voucher API (wave NINVOUCHER). Role model: admins run
 * programmes, beneficiary enrolment, allocation and distribution; farmers
 * self-serve their own vouchers; suppliers (agro-dealers) redeem against an
 * invoice; regulators + donors read programmes and reconciliation exports.
 * Every verification result carries the honest `basis` label ('stub' until
 * the NIMC/licensed vendor gate opens).
 */
@ApiTags('input-vouchers')
@Controller('input-vouchers')
export class InputVouchersController {
  constructor(
    private readonly vouchers: InputVouchersService,
    private readonly metrics: MetricsService
  ) {}

  // ------------------------------------------------------------ programmes

  @Post('programmes')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a subsidy programme with allocation rules + budget envelope (admin)' })
  async createProgramme(@Body() dto: CreateProgrammeDto, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.createProgramme(dto, actorOf(actor).id) };
  }

  @Get('programmes')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'List subsidy programmes (admin/regulator/donor)' })
  async listProgrammes(@Query('status') status?: ProgrammeStatus) {
    return { data: await this.vouchers.listProgrammes(status) };
  }

  @Get('programmes/:id')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'Programme detail (admin/regulator/donor)' })
  async getProgramme(@Param('id') id: string) {
    return { data: await this.vouchers.getProgramme(id) };
  }

  @Post('programmes/:id/activate')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Activate a DRAFT programme — encumbers the budget in the ledger (admin)' })
  async activateProgramme(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.activateProgramme(id, actorOf(actor).id) };
  }

  @Post('programmes/:id/close')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Close an ACTIVE programme to new allocations (admin)' })
  async closeProgramme(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.closeProgramme(id, actorOf(actor).id) };
  }

  // ---------------------------------------------------------- funding float

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('programmes/:id/funding')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Top up the programme funded float (admin; idempotent) — issuance only reserves against funded money'
  })
  async fundProgramme(@Param('id') id: string, @Body() dto: FundProgrammeDto, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.fundProgramme(id, dto, actorOf(actor).id) };
  }

  @Get('programmes/:id/funding')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({
    summary: 'Funded-float state: funded / reserved / settled / available kobo (admin/regulator/donor)'
  })
  async getProgrammeFunding(@Param('id') id: string, @CurrentUser() actor: User | null) {
    await this.vouchers.assertProgrammeReadScope(actorOf(actor), id);
    return { data: await this.vouchers.getProgrammeFunding(id) };
  }

  // ---------------------------------------------------------- beneficiaries

  @Post('programmes/:id/beneficiaries')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Verify a farmer NIN and enrol as beneficiary (admin; stub-labelled until the NIMC/vendor gate)'
  })
  async verifyBeneficiary(
    @Param('id') id: string,
    @Body() dto: VerifyBeneficiaryDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.vouchers.verifyBeneficiary(id, dto, actorOf(actor).id) };
  }

  @Get('programmes/:id/beneficiaries')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List verified beneficiaries — masked NIN + basis only (admin)' })
  async listBeneficiaries(@Param('id') id: string) {
    return { data: await this.vouchers.listBeneficiaries(id) };
  }

  // --------------------------------------------------------------- vouchers

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('programmes/:id/vouchers')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Allocate a voucher to a verified beneficiary (admin; idempotent)' })
  async allocateVoucher(
    @Param('id') id: string,
    @Body() dto: AllocateVoucherDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.vouchers.allocateVoucher(id, dto, actorOf(actor).id) };
  }

  @Get('programmes/:id/vouchers')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'List programme vouchers, optionally by status (admin/regulator/donor)' })
  async listProgrammeVouchers(
    @Param('id') id: string,
    @CurrentUser() actor: User | null,
    @Query('status') status?: InputVoucherStatus
  ) {
    await this.vouchers.assertProgrammeReadScope(actorOf(actor), id);
    return { data: await this.vouchers.listVouchers({ programmeId: id, status }) };
  }

  @Get('programmes/:id/reconciliation')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator', 'donor')
  @ApiOperation({
    summary: 'Settlement reconciliation: totals by programme/state with the ledger tie (exportable JSON)'
  })
  async reconciliation(@Param('id') id: string, @CurrentUser() actor: User | null) {
    await this.vouchers.assertProgrammeReadScope(actorOf(actor), id);
    return { data: await this.vouchers.reconciliation(id) };
  }

  @Get('farmers/me/vouchers')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'admin')
  @ApiOperation({ summary: 'Own subsidy vouchers (farmer self-service)' })
  async farmerVouchers(@CurrentUser() actor: User | null, @Query('status') status?: InputVoucherStatus) {
    return { data: await this.vouchers.listVouchers({ farmerId: actorOf(actor).id, status }) };
  }

  @Get('vouchers/:id')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'supplier', 'admin', 'regulator', 'donor')
  @ApiOperation({ summary: 'Voucher detail (farmer owner, supplier, admin, regulator, donor)' })
  async getVoucher(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const voucher = await this.vouchers.getVoucher(id);
    this.vouchers.assertFarmerStatementAccess(voucher.farmerId, actorOf(actor));
    return { data: voucher };
  }

  @Post('vouchers/:id/distribute')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Mark an ISSUED voucher distributed to the farmer (admin)' })
  async distributeVoucher(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.distributeVoucher(id, actorOf(actor).id) };
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('vouchers/:id/redeem')
  @UseGuards(RolesGuard)
  @Roles('supplier', 'admin')
  @ApiOperation({
    summary:
      'Redeem a voucher at an agro-dealer against an invoice (replay → 409). With an active programme ' +
      'insurance rider + voucher-insurance-rider flag, the premium debits the envelope atomically and a ' +
      'parametric cover binds in the same operation.'
  })
  async redeemVoucher(@Param('id') id: string, @Body() dto: RedeemVoucherDto, @CurrentUser() actor: User | null) {
    const caller = actorOf(actor);
    // V-78: redemption outcome counter (agric_voucher_redemptions_total{result})
    // so a redemption failure storm is visible to Prometheus alerts.
    try {
      const data = await this.vouchers.redeemVoucher(id, dto.invoiceRef, caller, {
        plotId: dto.plotId,
        amountKobo: dto.amountKobo
      });
      this.metrics.voucherRedemption('success');
      return { data };
    } catch (error) {
      this.metrics.voucherRedemption('failure');
      throw error;
    }
  }

  @Post('vouchers/:id/void')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Void an ISSUED voucher and release its encumbrance (admin)' })
  async voidVoucher(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.voidVoucher(id, actorOf(actor).id) };
  }

  @Post('vouchers/:id/expire')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Expire an ISSUED voucher past its expiry and release its encumbrance (admin)' })
  async expireVoucher(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.vouchers.expireVoucher(id, actorOf(actor).id) };
  }

  @Post('vouchers/:id/refund')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Refund a REDEEMED/PARTIALLY_REDEEMED voucher (V-02): reposts balanced reversals of every ' +
      'redemption part (dealer-settlement clawback), returns the settled float, releases any ' +
      'unredeemed remainder and links the complaint case. Idempotent replay returns the refund.'
  })
  async refundVoucher(@Param('id') id: string, @Body() dto: RefundVoucherDto, @CurrentUser() actor: User | null) {
    return {
      data: await this.vouchers.refundVoucher(id, actorOf(actor).id, {
        reason: dto.reason,
        complaintCaseId: dto.complaintCaseId
      })
    };
  }

  // ------------------------------------------------------ identity adapter

  @Get('identity/status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Identity adapter status — stub/live, honestly labelled (admin)' })
  async identityStatus() {
    return { data: this.vouchers.identityStatus() };
  }
}

/** Exported so validation pipes pick the status unions up for OpenAPI. */
export { INPUT_VOUCHER_STATUSES, PROGRAMME_STATUSES };
