import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Optional,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';
import { LOAN_STATUSES, type LoanStatus, type User } from '@agric-platform/shared';
import {
  AUTHORIZATION_CHECK,
  type AuthorizationCheck
} from '../../common/auth/authorization-check.driver.js';
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

class PayInstallmentDto {
  @IsOptional()
  @IsString()
  paymentReference?: string;
}

class DeclarePaymentDto {
  @IsString()
  paymentReference!: string;
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
    private readonly audit: AuditService,
    @Optional() @Inject(AUTHORIZATION_CHECK) private readonly authz?: AuthorizationCheck
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
    // Wave FABRIC: with AUTHORIZATION_DRIVER=permify the credit-loan read
    // check goes through the AuthorizationCheck port (fail closed: provider
    // errors answer 503, denials 403). The default stub driver keeps the
    // existing assertSelfOrAdmin behaviour byte-for-byte.
    if (this.authz && this.authz.name !== 'stub') {
      const user = requireActor(actor);
      let allowed = false;
      try {
        allowed = await this.authz.can(
          { userId: user.id, roles: user.roles },
          'read',
          { type: 'credit_loan', id: loan.id, ownerId: loan.applicantId }
        );
      } catch {
        throw new ServiceUnavailableException(
          'Authorization provider unreachable — failing closed (deny)'
        );
      }
      if (!allowed) {
        throw new ForbiddenException('You may only access your own records');
      }
    } else {
      assertSelfOrAdmin(actor, loan.applicantId);
    }
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

  /**
   * CRIT-1 fix: confirming an installment payment posts real money into the
   * ledger, so it is restricted to the lender side (platform admins acting
   * for the lender). Borrowers use declare-payment instead — a borrower can
   * no longer write off their own debt unilaterally.
   */
  @Post(':id/installments/:sequence/pay')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Confirm a repayment installment as paid (lender-side/admin only); posts to the ledger'
  })
  async payInstallment(
    @Param('id') id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: PayInstallmentDto,
    @CurrentUser() actor: User | null
  ) {
    const user = requireActor(actor);
    const installment = await this.loans.markInstallmentPaid(id, sequence, user.id, {
      paymentReference: dto?.paymentReference
    });
    await this.audit.record({
      actorId: user.id,
      action: 'loan.installment_paid',
      entityType: 'repayment_installment',
      entityId: installment.id,
      metadata: { loanId: id, sequence, paymentReference: dto?.paymentReference }
    });
    return { data: installment };
  }

  /**
   * Borrower-side payment declaration: records the external payment
   * reference and moves the installment to 'declared' (pending lender
   * confirmation). No ledger posting happens until an admin confirms via
   * the pay endpoint above.
   */
  @Post(':id/installments/:sequence/declare-payment')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({
    summary: 'Declare an installment payment with a verifiable reference (borrower or admin)'
  })
  async declarePayment(
    @Param('id') id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: DeclarePaymentDto,
    @CurrentUser() actor: User | null
  ) {
    const user = requireActor(actor);
    const loan = await this.loans.getLoan(id);
    assertSelfOrAdmin(user, loan.applicantId);
    const installment = await this.loans.declarePayment(id, sequence, user.id, dto.paymentReference);
    await this.audit.record({
      actorId: user.id,
      action: 'loan.installment_payment_declared',
      entityType: 'repayment_installment',
      entityId: installment.id,
      metadata: { loanId: id, sequence, paymentReference: dto.paymentReference }
    });
    return { data: installment };
  }
}
