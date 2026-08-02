import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import {
  addMonthsIso,
  generateAmortisationSchedule,
  type Lender,
  type LoanApplication,
  type LoanStatus,
  type RepaymentInstallment,
  type User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  LENDER_REPOSITORY,
  LOAN_APPLICATION_REPOSITORY,
  REPAYMENT_SCHEDULE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { LenderRepository } from '../../database/repositories/lender.repository.js';
import type {
  LoanApplicationRepository,
  LoanCriteria,
  RepaymentScheduleRepository
} from '../../database/repositories/loan.repository.js';
import { CreditService } from './credit.service.js';
import { LedgerService } from './ledger.service.js';

/** Who may drive a loan transition: the applicant or a reviewer (admin). */
type LoanActor = 'applicant' | 'reviewer';

/**
 * Loan workflow state machine:
 * DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED | DECLINED → DISBURSED →
 * REPAYING → CLOSED | DEFAULTED. Disbursement, repayment-start and closure
 * are system-driven (dedicated service methods), never the generic
 * transition endpoint.
 */
export const LOAN_TRANSITIONS: Readonly<
  Record<LoanStatus, Readonly<Partial<Record<LoanStatus, readonly LoanActor[]>>>>
> = {
  draft: {
    submitted: ['applicant']
  },
  submitted: {
    under_review: ['reviewer'],
    declined: ['reviewer']
  },
  under_review: {
    approved: ['reviewer'],
    declined: ['reviewer']
  },
  approved: {},
  declined: {},
  disbursed: {
    repaying: ['reviewer']
  },
  repaying: {
    closed: ['reviewer'],
    defaulted: ['reviewer']
  },
  closed: {},
  defaulted: {}
};

export interface CreateLoanApplicationInput {
  applicantId: string;
  lenderId: string;
  amountKobo: number;
  termMonths: number;
  annualRateBps: number;
  purpose?: string;
}

export interface LenderRanking {
  lender: Lender;
  eligible: boolean;
  matchScore: number;
  reason: string;
}

@Injectable()
export class LoanService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly ledger: LedgerService,
    private readonly credit: CreditService,
    @Inject(LENDER_REPOSITORY) private readonly lenders: LenderRepository,
    @Inject(LOAN_APPLICATION_REPOSITORY) private readonly loans: LoanApplicationRepository,
    @Inject(REPAYMENT_SCHEDULE_REPOSITORY) private readonly schedules: RepaymentScheduleRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  /* ---------------------------------------------------------- lenders -- */

  async listLenders(activeOnly = true): Promise<Lender[]> {
    return this.lenders.find(activeOnly ? { active: true } : {});
  }

  async createLender(
    input: Omit<Lender, 'id' | 'isActive'> & { isActive?: boolean },
    actorId: string
  ): Promise<Lender> {
    if (input.maxTicketKobo < input.minTicketKobo) {
      throw new BadRequestException('maxTicketKobo must be >= minTicketKobo');
    }
    const lender: Lender = {
      id: newId('lender'),
      name: input.name,
      product: input.product,
      minTicketKobo: input.minTicketKobo,
      maxTicketKobo: input.maxTicketKobo,
      minScore: input.minScore,
      criteria: input.criteria,
      isActive: input.isActive ?? true
    };
    const created = await this.lenders.create(lender);
    await this.events.publish('finance.lender.registered', { lenderId: created.id }, actorId);
    return created;
  }

  /** Ranks the active lender directory against the member's credit score. */
  async matchLenders(userId: string): Promise<LenderRanking[]> {
    const { score } = await this.credit.scoreForUser(userId);
    const active = await this.lenders.find({ active: true });
    return active
      .map((lender) => {
        const eligible = score >= lender.minScore;
        return {
          lender,
          eligible,
          matchScore: score - lender.minScore,
          reason: eligible
            ? `Score ${score} meets the ${lender.minScore}+ requirement`
            : `Requires credit score ${lender.minScore}+ (current ${score})`
        };
      })
      .sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;
        if (a.lender.maxTicketKobo !== b.lender.maxTicketKobo) {
          return b.lender.maxTicketKobo - a.lender.maxTicketKobo;
        }
        return a.lender.name.localeCompare(b.lender.name);
      });
  }

  /* ------------------------------------------------------------ loans -- */

  async apply(input: CreateLoanApplicationInput): Promise<LoanApplication> {
    const lender = await this.lenders.getById(input.lenderId);
    if (!lender.isActive) {
      throw new BadRequestException(`Lender '${lender.name}' is not accepting applications`);
    }
    if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo <= 0) {
      throw new BadRequestException('amountKobo must be a positive integer kobo amount');
    }
    if (input.amountKobo < lender.minTicketKobo || input.amountKobo > lender.maxTicketKobo) {
      throw new BadRequestException(
        `amountKobo must be within the lender ticket range ${lender.minTicketKobo}–${lender.maxTicketKobo} kobo`
      );
    }
    if (!Number.isSafeInteger(input.termMonths) || input.termMonths < 1) {
      throw new BadRequestException('termMonths must be a positive integer');
    }
    if (!Number.isSafeInteger(input.annualRateBps) || input.annualRateBps < 0) {
      throw new BadRequestException('annualRateBps must be a non-negative integer');
    }
    const now = new Date().toISOString();
    const loan: LoanApplication = {
      id: newId('loan'),
      applicantId: input.applicantId,
      lenderId: input.lenderId,
      productName: lender.product,
      amountKobo: input.amountKobo,
      termMonths: input.termMonths,
      annualRateBps: input.annualRateBps,
      purpose: input.purpose,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.loans.create(loan);
    await this.events.publish(
      'finance.loan.created',
      { loanId: created.id, applicantId: created.applicantId, amountKobo: created.amountKobo },
      input.applicantId
    );
    return created;
  }

  async listLoans(filter: LoanCriteria): Promise<LoanApplication[]> {
    return this.loans.find(filter);
  }

  async getLoan(id: string): Promise<LoanApplication> {
    return this.loans.getById(id);
  }

  /**
   * Generic reviewer/applicant transitions. Disbursement (approved →
   * disbursed → repaying) goes through disburse(); closure goes through the
   * repayment path; both are rejected here.
   */
  async transition(
    id: string,
    status: LoanStatus,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<LoanApplication> {
    if (status === 'disbursed' || status === 'repaying' || status === 'closed') {
      throw new BadRequestException(
        `Status '${status}' is system-driven; use the disburse or repayment endpoints`
      );
    }
    const loan = await this.loans.getById(id);
    if (loan.status === status) {
      return loan; // idempotent replay
    }
    const allowed = LOAN_TRANSITIONS[loan.status]?.[status];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid loan transition '${loan.status}' -> '${status}' for loan ${id}`
      );
    }
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin) {
      const party: LoanActor = actor.id === loan.applicantId ? 'applicant' : 'reviewer';
      if (actor.id !== loan.applicantId || !allowed.includes(party)) {
        throw new ForbiddenException(
          `Only the loan ${allowed.includes('applicant') ? 'applicant' : 'reviewer (admin)'} may move a loan from '${loan.status}' to '${status}'`
        );
      }
    }
    const now = new Date().toISOString();
    const updated = await this.loans.update(id, {
      status,
      submittedAt: status === 'submitted' ? now : loan.submittedAt,
      decidedAt: status === 'approved' || status === 'declined' ? now : loan.decidedAt,
      updatedAt: now
    });
    if (status === 'approved' || status === 'declined') {
      await this.audit?.record({
        actorId: actor.id,
        action: `finance.loan.${status}`,
        entityType: 'loan_application',
        entityId: id,
        metadata: { from: loan.status, to: status, amountKobo: loan.amountKobo }
      });
    }
    await this.events.publish(
      'finance.loan.status_changed',
      { loanId: id, from: loan.status, to: status },
      actor.id
    );
    return updated;
  }

  /**
   * Disburses an approved loan: posts the double-entry disbursement to the
   * ledger (member receivable debit / platform cash credit), generates the
   * equal-installment repayment calendar, and advances the loan to
   * 'repaying'. Idempotent: an already-disbursed loan returns unchanged.
   */
  async disburse(id: string, actorId: string, firstDueDate?: string): Promise<LoanApplication> {
    const loan = await this.loans.getById(id);
    if (loan.status === 'repaying' || loan.status === 'closed') {
      return loan; // idempotent replay of a disbursement retry
    }
    if (loan.status !== 'approved') {
      throw new BadRequestException(`Only approved loans can be disbursed (loan is '${loan.status}')`);
    }
    const receivable = await this.ledger.ensureAccount({
      code: `member:${loan.applicantId}:loans_receivable`,
      type: 'asset',
      ownerId: loan.applicantId
    });
    await this.ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
    const now = new Date().toISOString();
    await this.ledger.postEntry(
      {
        idempotencyKey: `loan-disbursement:${loan.id}`,
        referenceType: 'loan_application',
        referenceId: loan.id,
        description: `Loan disbursement to ${loan.applicantId}`,
        postings: [
          { accountCode: receivable.code, direction: 'debit', amountKobo: loan.amountKobo },
          { accountCode: 'platform:cash', direction: 'credit', amountKobo: loan.amountKobo }
        ]
      },
      actorId
    );
    const schedule = generateAmortisationSchedule({
      principalKobo: loan.amountKobo,
      annualRateBps: loan.annualRateBps,
      termMonths: loan.termMonths,
      firstDueDate: firstDueDate ?? addMonthsIso(now.slice(0, 10), 1)
    }).map(
      (installment): RepaymentInstallment => ({
        id: newId('installment'),
        loanId: loan.id,
        sequence: installment.sequence,
        dueDate: installment.dueDate,
        principalKobo: installment.principalKobo,
        interestKobo: installment.interestKobo,
        totalKobo: installment.totalKobo,
        status: 'pending'
      })
    );
    await this.schedules.replaceSchedule(loan.id, schedule);
    const updated = await this.loans.update(id, {
      status: 'repaying',
      disbursedAt: loan.disbursedAt ?? now,
      updatedAt: now
    });
    await this.audit?.record({
      actorId,
      action: 'finance.loan.disbursed',
      entityType: 'loan_application',
      entityId: id,
      metadata: { amountKobo: loan.amountKobo, termMonths: loan.termMonths, annualRateBps: loan.annualRateBps }
    });
    await this.events.publish(
      'finance.loan.disbursed',
      { loanId: id, applicantId: loan.applicantId, amountKobo: loan.amountKobo },
      actorId
    );
    return updated;
  }

  async scheduleForLoan(loanId: string): Promise<RepaymentInstallment[]> {
    await this.loans.getById(loanId);
    const installments = await this.schedules.find({ loanId });
    return installments.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Marks a schedule installment paid and posts the balanced repayment to
   * the ledger (platform cash debit; member receivable + interest income
   * credits). When the final installment is paid the loan closes.
   */
  async markInstallmentPaid(
    loanId: string,
    sequence: number,
    actorId: string,
    paidAt?: string
  ): Promise<RepaymentInstallment> {
    const loan = await this.loans.getById(loanId);
    if (loan.status !== 'repaying') {
      throw new BadRequestException(`Loan ${loanId} is not repaying (status '${loan.status}')`);
    }
    const installments = await this.scheduleForLoan(loanId);
    const installment = installments.find((item) => item.sequence === sequence);
    if (!installment) {
      throw new NotFoundException(`Installment ${sequence} not found for loan ${loanId}`);
    }
    if (installment.status === 'paid') {
      return installment; // idempotent replay
    }
    const now = paidAt ?? new Date().toISOString();
    const postings = [
      { accountCode: 'platform:cash', direction: 'debit' as const, amountKobo: installment.totalKobo },
      {
        accountCode: `member:${loan.applicantId}:loans_receivable`,
        direction: 'credit' as const,
        amountKobo: installment.principalKobo
      }
    ];
    if (installment.interestKobo > 0) {
      postings.push({
        accountCode: 'platform:interest_income',
        direction: 'credit' as const,
        amountKobo: installment.interestKobo
      });
    }
    await this.ledger.postEntry(
      {
        idempotencyKey: `loan-repayment:${loanId}:${sequence}`,
        referenceType: 'loan_application',
        referenceId: loanId,
        description: `Loan repayment installment ${sequence}`,
        postings
      },
      actorId
    );
    const updated = await this.schedules.update(installment.id, {
      status: 'paid',
      paidAt: now
    });
    await this.audit?.record({
      actorId,
      action: 'finance.loan.repayment_received',
      entityType: 'repayment_installment',
      entityId: installment.id,
      metadata: { loanId, sequence, totalKobo: installment.totalKobo }
    });
    await this.events.publish(
      'finance.loan.repayment_received',
      { loanId, sequence, totalKobo: installment.totalKobo },
      actorId
    );
    const remaining = installments.filter(
      (item) => item.id !== installment.id && item.status !== 'paid'
    );
    if (remaining.length === 0) {
      await this.loans.update(loanId, { status: 'closed', closedAt: now, updatedAt: now });
      await this.events.publish('finance.loan.closed', { loanId }, actorId);
    }
    return updated;
  }
}
