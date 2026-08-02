import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import {
  DISBURSEMENT_MILESTONES,
  LIVESTOCK_SUBJECT_TYPES
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type { ScheduleDisbursementInput } from './disbursements.service.js';
import { DisbursementsService } from './disbursements.service.js';
import type { QuotePolicyInput, SubmitClaimInput } from './insurance.service.js';
import { InsuranceService } from './insurance.service.js';
import type { RegisterLienInput } from './liens.service.js';
import { LiensService } from './liens.service.js';

class RegisterLienDto implements RegisterLienInput {
  @IsIn([...LIVESTOCK_SUBJECT_TYPES])
  subjectType!: RegisterLienInput['subjectType'];

  @IsString()
  subjectId!: string;

  @IsInt()
  @Min(1)
  principalKobo!: number;

  @IsString()
  @IsNotEmpty()
  terms!: string;
}

class ListLiensQuery {
  @IsIn([...LIVESTOCK_SUBJECT_TYPES])
  subjectType!: RegisterLienInput['subjectType'];

  @IsString()
  subjectId!: string;
}

class QuotePolicyDto implements QuotePolicyInput {
  @IsIn([...LIVESTOCK_SUBJECT_TYPES])
  subjectType!: QuotePolicyInput['subjectType'];

  @IsString()
  subjectId!: string;

  @IsInt()
  @Min(1)
  premiumKobo!: number;

  @IsInt()
  @Min(1)
  coverageKobo!: number;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;
}

class SubmitClaimDto implements SubmitClaimInput {
  @IsString()
  policyId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  animalIds!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  amountKobo?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

class AssessClaimDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  amountKobo?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

class SettleClaimDto {
  @IsIn(['paid', 'rejected'])
  outcome!: 'paid' | 'rejected';
}

class ScheduleDisbursementDto implements ScheduleDisbursementInput {
  @IsString()
  @IsNotEmpty()
  programmeId!: string;

  @IsIn([...DISBURSEMENT_MILESTONES])
  milestone!: ScheduleDisbursementInput['milestone'];

  @IsInt()
  @Min(1)
  amountKobo!: number;

  @IsString()
  beneficiaryUserId!: string;
}

@ApiTags('livestock-finance')
@Controller('livestock-finance')
@UseGuards(RolesGuard)
export class LivestockFinanceController {
  constructor(
    private readonly liens: LiensService,
    private readonly insurance: InsuranceService,
    private readonly disbursements: DisbursementsService
  ) {}

  // -- Liens (⚖ activation requires Nigerian legal/regulatory review) ---------

  @Post('liens')
  @Authenticated()
  @ApiOperation({
    summary:
      'Register an active lien against an animal/lot (lender role). Blocks transfer/sale while active. Idempotency-Key supported.'
  })
  async registerLien(@Body() dto: RegisterLienDto, @CurrentUser() actor: User | null) {
    return { data: await this.liens.register(actor, dto) };
  }

  @Get('liens/mine')
  @Authenticated()
  @ApiOperation({ summary: 'Liens registered by the caller (lender)' })
  async listMyLiens(@CurrentUser() actor: User | null) {
    return { data: await this.liens.listMine(actor) };
  }

  @Get('liens')
  @Authenticated()
  @ApiOperation({ summary: 'Lien history for a subject (owner, lender or admin)' })
  async listLiens(@Query() query: ListLiensQuery, @CurrentUser() actor: User | null) {
    return { data: await this.liens.listForSubject(actor, query.subjectType, query.subjectId) };
  }

  @Post('liens/:id/discharge')
  @Authenticated()
  @ApiOperation({ summary: 'Discharge an active lien (registering lender or admin)' })
  async dischargeLien(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.liens.discharge(actor, id) };
  }

  @Post('liens/:id/default')
  @Authenticated()
  @ApiOperation({ summary: 'Mark an active lien defaulted (registering lender or admin)' })
  async defaultLien(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.liens.markDefaulted(actor, id) };
  }

  // -- Insurance ----------------------------------------------------------------

  @Post('insurance/quotes')
  @Authenticated()
  @ApiOperation({ summary: 'Create an insurance quote for owned livestock' })
  async quote(@Body() dto: QuotePolicyDto, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.quote(actor, dto) };
  }

  @Post('insurance/policies/:id/bind')
  @Authenticated()
  @ApiOperation({
    summary:
      'Bind a quote with the underwriter (insurer role). Fails closed while no provider is configured.'
  })
  async bind(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.bind(actor, id) };
  }

  @Post('insurance/policies/:id/lapse')
  @Authenticated()
  @ApiOperation({ summary: 'Lapse a bound policy (insurer of record or admin)' })
  async lapse(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.lapse(actor, id) };
  }

  @Post('insurance/policies/:id/cancel')
  @Authenticated()
  @ApiOperation({ summary: 'Cancel a quote/bound policy (holder, insurer or admin)' })
  async cancel(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.cancel(actor, id) };
  }

  @Get('insurance/policies/mine')
  @Authenticated()
  @ApiOperation({ summary: "List the caller's policies" })
  async listMyPolicies(@CurrentUser() actor: User | null) {
    return { data: await this.insurance.listMine(actor) };
  }

  @Get('insurance/policies/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Policy detail (holder, insurer or admin)' })
  async getPolicy(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.getPolicy(actor, id) };
  }

  @Post('insurance/claims')
  @Authenticated()
  @ApiOperation({ summary: 'Submit a claim against a bound policy (holder)' })
  async submitClaim(@Body() dto: SubmitClaimDto, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.submitClaim(actor, dto) };
  }

  @Get('insurance/claims')
  @Authenticated()
  @ApiOperation({ summary: 'Claims for a policy (holder, insurer or admin)' })
  async listClaims(@Query('policyId') policyId: string, @CurrentUser() actor: User | null) {
    return { data: await this.insurance.listClaimsForPolicy(actor, policyId) };
  }

  @Post('insurance/claims/:id/assess')
  @Authenticated()
  @ApiOperation({ summary: 'submitted → assessed (insurer of record or admin)' })
  async assessClaim(
    @Param('id') id: string,
    @Body() dto: AssessClaimDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.insurance.assessClaim(actor, id, dto) };
  }

  @Post('insurance/claims/:id/settle')
  @Authenticated()
  @ApiOperation({ summary: 'assessed → paid|rejected (insurer of record or admin)' })
  async settleClaim(
    @Param('id') id: string,
    @Body() dto: SettleClaimDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.insurance.settleClaim(actor, id, dto.outcome) };
  }

  // -- Donor disbursements -------------------------------------------------------

  @Post('disbursements')
  @Authenticated()
  @ApiOperation({
    summary:
      'Schedule a programme-linked milestone disbursement (donor role). The (programme, milestone, beneficiary) triple is unique.'
  })
  async schedule(@Body() dto: ScheduleDisbursementDto, @CurrentUser() actor: User | null) {
    return { data: await this.disbursements.schedule(actor, dto) };
  }

  @Post('disbursements/:id/release')
  @Authenticated()
  @ApiOperation({ summary: 'Release a scheduled disbursement (idempotent; scheduling donor or admin)' })
  async release(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.disbursements.release(actor, id) };
  }

  @Post('disbursements/:id/confirm')
  @Authenticated()
  @ApiOperation({ summary: 'Confirm receipt of a released disbursement (beneficiary or admin)' })
  async confirm(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.disbursements.confirm(actor, id) };
  }

  @Get('disbursements/mine')
  @Authenticated()
  @ApiOperation({ summary: 'Disbursements scheduled by the caller (donor)' })
  async listMyDisbursements(@CurrentUser() actor: User | null) {
    return { data: await this.disbursements.listMine(actor) };
  }

  @Get('disbursements/beneficiary/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Disbursements for a beneficiary (self or admin)' })
  async listForBeneficiary(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    return { data: await this.disbursements.listForBeneficiary(actor, userId) };
  }
}
