import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CREDIT_LOAN_STATUSES, type CreditLoanStatus, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  CreditService,
  type AddCollateralInput,
  type ApplyForGroupLoanInput,
  type ApplyForLoanInput
} from './credit.service.js';
import {
  SEASONAL_REPAYMENT_FLAG,
  SeasonalScheduleService,
  type PreviewSeasonalScheduleInput
} from './seasonal-schedule.service.js';

class ApplyDto implements ApplyForLoanInput {
  @IsString()
  @MaxLength(100)
  productId!: string;

  @IsInt()
  @Min(1)
  principalKobo!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  purpose?: string;
}

class ApplyGroupDto extends ApplyDto implements ApplyForGroupLoanInput {
  @IsString()
  @MaxLength(100)
  groupId!: string;
}

class AddCollateralDto implements AddCollateralInput {
  @IsString()
  @MaxLength(500)
  kind!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsInt()
  @Min(0)
  estimatedValueKobo!: number;
}

class InviteGuarantorDto {
  @IsString()
  @MaxLength(100)
  guarantorUserId!: string;
}

class PreviewSeasonalScheduleDto implements PreviewSeasonalScheduleInput {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  plotId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  crop?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  plantingDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  harvestWindowStart?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  harvestWindowEnd?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  harvestInstallments?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  harvestWindowDays?: number;
}

class AcceptSeasonalScheduleDto {
  @IsString()
  @MaxLength(100)
  scheduleId!: string;
}

class ListLoansQuery {
  @IsOptional()
  @IsIn(CREDIT_LOAN_STATUSES)
  status?: CreditLoanStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  applicantUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  groupId?: string;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Credit loan applications: farmer create/submit, reviewer
 * score/approve/reject/disburse, repayment schedule + payments, collateral
 * and guarantor workflows.
 */
@ApiTags('credit')
@Controller('credit/applications')
export class CreditApplicationsController {
  constructor(
    private readonly credit: CreditService,
    private readonly seasonal: SeasonalScheduleService
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Create a draft loan application (own record)' })
  async apply(@Body() dto: ApplyDto, @CurrentUser() actor: User | null) {
    return { data: await this.credit.apply(dto, requireActor(actor)) };
  }

  @Post('group')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Create a VSLA group loan application (group members; co-obligors recorded)' })
  async applyGroup(@Body() dto: ApplyGroupDto, @CurrentUser() actor: User | null) {
    return { data: await this.credit.applyForGroup(dto, requireActor(actor)) };
  }

  @Get()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List applications (own; admin|lender may filter all)' })
  async list(@CurrentUser() actor: User | null, @Query() query: ListLoansQuery) {
    return { data: await this.credit.listLoans(requireActor(actor), query) };
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Application detail (applicant, guarantor, or admin|lender)' })
  async get(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.getLoan(id, requireActor(actor)) };
  }

  @Post(':id/submit')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Submit a draft application (applicant)' })
  async submit(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.submit(id, requireActor(actor)) };
  }

  @Post(':id/score')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Compute + persist the 5-factor credit score (admin|lender)' })
  async score(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.score(id, requireActor(actor)) };
  }

  @Post(':id/approve')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Approve a scored application; generates the repayment schedule (admin|lender)' })
  async approve(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.approve(id, requireActor(actor)) };
  }

  @Post(':id/reject')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Reject a scored application (admin|lender)' })
  async reject(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.reject(id, requireActor(actor)) };
  }

  @Post(':id/disburse')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({
    summary:
      'Record disbursement (admin|lender); money movement stays with the funds flow'
  })
  async disburse(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.disburse(id, requireActor(actor)) };
  }

  @Post(':id/start-repayment')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Activate the repayment calendar (admin|lender)' })
  async startRepayment(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.startRepayment(id, requireActor(actor)) };
  }

  @Post(':id/default')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Default a repaying loan; unpaid installments marked missed (admin|lender)' })
  async defaultLoan(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.defaultLoan(id, requireActor(actor)) };
  }

  @Post(':id/write-off')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Write off a defaulted loan (admin)' })
  async writeOff(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.writeOff(id, requireActor(actor)) };
  }

  /* ------------------------------------------------------ repayments -- */

  @Get(':id/schedule')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Repayment schedule with read-time late marking (party)' })
  async schedule(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.getSchedule(id, requireActor(actor)) };
  }

  /* ---------------------------------- seasonal schedules (SeasonSync) -- */

  @Get(':id/seasonal-schedules')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Authenticated()
  @RequiresFeature(SEASONAL_REPAYMENT_FLAG)
  @ApiOperation({
    summary: 'List pinned seasonal schedule versions for a loan (party; flag seasonal-repayment)'
  })
  async seasonalSchedules(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.seasonal.listForLoan(id, requireActor(actor)) };
  }

  @Post(':id/seasonal-schedule/preview')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin', 'lender')
  @RequiresFeature(SEASONAL_REPAYMENT_FLAG)
  @ApiOperation({
    summary:
      'Preview a harvest-linked repayment schedule (admin|lender; flag seasonal-repayment). ' +
      'Calendar comes from the borrower plot’s growing planting or explicit capture; ' +
      '422 CROP_CALENDAR_REQUIRED when neither exists.'
  })
  async previewSeasonalSchedule(
    @Param('id') id: string,
    @Body() dto: PreviewSeasonalScheduleDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.seasonal.preview(id, dto, requireActor(actor)) };
  }

  @Post(':id/accept-schedule')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Roles('admin', 'lender')
  @RequiresFeature(SEASONAL_REPAYMENT_FLAG)
  @ApiOperation({
    summary:
      'Accept a previewed seasonal schedule (admin|lender; flag seasonal-repayment): ' +
      'replaces the approved loan’s pending equal installments with the pinned seasonal ' +
      'installments. Idempotent on replay; 409 on concurrent accept or stale terms.'
  })
  async acceptSeasonalSchedule(
    @Param('id') id: string,
    @Body() dto: AcceptSeasonalScheduleDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.seasonal.accept(id, dto.scheduleId, requireActor(actor)) };
  }

  @Post(':id/repayments/:sequence/pay')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Record an installment payment — idempotent (borrower or admin|lender)' })
  async pay(
    @Param('id') id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.recordPayment(id, sequence, requireActor(actor)) };
  }

  /* ------------------------------------------------------ collateral -- */

  @Get(':id/collateral')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List collateral pledged against a loan (party)' })
  async listCollateral(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.listCollateral(id, requireActor(actor)) };
  }

  @Post(':id/collateral')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Pledge collateral while under assessment (borrower or admin|lender)' })
  async addCollateral(
    @Param('id') id: string,
    @Body() dto: AddCollateralDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.addCollateral(id, dto, requireActor(actor)) };
  }

  @Post('collateral/:collateralId/release')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Release pledged collateral (admin|lender)' })
  async releaseCollateral(
    @Param('collateralId') collateralId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.releaseCollateral(collateralId, requireActor(actor)) };
  }

  @Post('collateral/:collateralId/claim')
  @UseGuards(RolesGuard)
  @Roles('admin', 'lender')
  @ApiOperation({ summary: 'Claim collateral on a defaulted loan (admin|lender)' })
  async claimCollateral(
    @Param('collateralId') collateralId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.claimCollateral(collateralId, requireActor(actor)) };
  }

  /* ------------------------------------------------------ guarantors -- */

  @Get(':id/guarantors')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List guarantors / group co-obligors (party)' })
  async listGuarantors(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.credit.listGuarantors(id, requireActor(actor)) };
  }

  @Post(':id/guarantors')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Invite a guarantor (borrower, while draft|submitted)' })
  async inviteGuarantor(
    @Param('id') id: string,
    @Body() dto: InviteGuarantorDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.inviteGuarantor(id, dto.guarantorUserId, requireActor(actor)) };
  }

  @Post('guarantors/:guarantorId/accept')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Accept a guarantor invitation (invited guarantor only)' })
  async acceptGuarantor(
    @Param('guarantorId') guarantorId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.acceptGuarantor(guarantorId, requireActor(actor)) };
  }

  @Post('guarantors/:guarantorId/decline')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Decline a guarantor invitation (invited guarantor only)' })
  async declineGuarantor(
    @Param('guarantorId') guarantorId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.credit.declineGuarantor(guarantorId, requireActor(actor)) };
  }
}
