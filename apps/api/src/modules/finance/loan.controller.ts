import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';
import { LOAN_STATUSES, type LoanStatus, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AuditService } from '../../core/audit.service.js';
import { LoanService, type CreateLoanApplicationInput } from './loan.service.js';

class CreateLoanApplicationDto implements CreateLoanApplicationInput {
  @IsString()
  applicantId!: string;

  @IsString()
  lenderId!: string;

  @IsInt()
  @Min(1)
  amountKobo!: number;

  @IsInt()
  @Min(1)
  termMonths!: number;

  @IsInt()
  @Min(0)
  annualRateBps!: number;

  @IsOptional()
  @IsString()
  purpose?: string;
}

class LoanStatusDto {
  @IsIn(LOAN_STATUSES)
  status!: LoanStatus;
}

class DisburseDto {
  @IsOptional()
  @IsISO8601()
  firstDueDate?: string;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/** Loan workflows: application state machine, disbursement, repayment calendar. */
@ApiTags('finance')
@Controller('finance/loans')
export class LoanController {
  constructor(
    private readonly loans: LoanService,
    private readonly audit: AuditService
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Create a draft loan application (own record or admin)' })
  async apply(@Body() dto: CreateLoanApplicationDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.applicantId);
    return { data: await this.loans.apply(dto) };
  }

  @Get()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List loan applications (own records or admin)' })
  async list(
    @CurrentUser() actor: User | null,
    @Query('applicantId') applicantId?: string,
    @Query('lenderId') lenderId?: string,
    @Query('status') status?: LoanStatus
  ) {
    const user = requireActor(actor);
    if (!user.roles.includes('admin')) {
      assertSelfOrAdmin(user, applicantId ?? '');
    }
    return { data: await this.loans.listLoans({ applicantId, lenderId, status }) };
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Loan application detail (applicant or admin)' })
  async get(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const loan = await this.loans.getLoan(id);
    assertSelfOrAdmin(actor, loan.applicantId);
    return { data: loan };
  }

  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Transition a loan application (state machine enforced, actor-scoped)' })
  async transition(
    @Param('id') id: string,
    @Body() dto: LoanStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.loans.transition(id, dto.status, requireActor(actor)) };
  }

  @Post(':id/disburse')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Disburse an approved loan: ledger posting + repayment calendar (admin)' })
  async disburse(
    @Param('id') id: string,
    @Body() dto: DisburseDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.loans.disburse(id, actor?.id ?? 'anonymous', dto.firstDueDate) };
  }

  @Get(':id/schedule')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Repayment calendar for a loan (applicant or admin)' })
  async schedule(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const loan = await this.loans.getLoan(id);
    assertSelfOrAdmin(actor, loan.applicantId);
    return { data: await this.loans.scheduleForLoan(id) };
  }

  @Post(':id/installments/:sequence/pay')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Mark a repayment installment paid; posts to the ledger' })
  async payInstallment(
    @Param('id') id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @CurrentUser() actor: User | null
  ) {
    const user = requireActor(actor);
    const loan = await this.loans.getLoan(id);
    assertSelfOrAdmin(user, loan.applicantId);
    const installment = await this.loans.markInstallmentPaid(id, sequence, user.id);
    await this.audit.record({
      actorId: user.id,
      action: 'loan.installment_paid',
      entityType: 'repayment_installment',
      entityId: installment.id,
      metadata: { loanId: id, sequence }
    });
    return { data: installment };
  }
}
