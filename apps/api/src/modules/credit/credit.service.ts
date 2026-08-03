import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import {
  CREDIT_FACTOR_MAX,
  CREDIT_SCORE_MAX,
  type CreditCollateral,
  type CreditGuarantor,
  type CreditLoanApplication,
  type CreditLoanProduct,
  type CreditLoanStatus,
  type CreditPortfolioReport,
  type CreditRepayment,
  type CreditScoreAssessment,
  type CreditScoreFactors,
  type User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CREDIT_COLLATERAL_REPOSITORY,
  CREDIT_GUARANTOR_REPOSITORY,
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_PRODUCT_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  ORDER_REPOSITORY,
  PROFILE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CreditCollateralRepository,
  CreditGroupMemberRepository,
  CreditGuarantorRepository,
  CreditLoanCriteria,
  CreditLoanRepository,
  CreditProductRepository,
  CreditRepaymentRepository,
  CreditSavingsAccountRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';

/** Actor driving a credit mutation: the applicant or a reviewer (admin|lender). */
export type CreditActor = Pick<User, 'id' | 'roles'>;

type LoanParty = 'applicant' | 'reviewer';

const DAY_MS = 86_400_000;

/**
 * Credit loan lifecycle state machine (Wave CREDIT):
 *   draft → submitted → scoring → approved | rejected
 *   approved → disbursed → repaying → repaid | defaulted → written_off
 * `repaid` is system-driven (last installment paid) and never accepted by
 * the generic transition guard. Every transition is a guarded
 * compare-and-set (updateExpected) with an audit entry and a domain event.
 */
export const CREDIT_LOAN_TRANSITIONS: Readonly<
  Record<CreditLoanStatus, Readonly<Partial<Record<CreditLoanStatus, readonly LoanParty[]>>>>
> = {
  draft: { submitted: ['applicant'] },
  submitted: { scoring: ['reviewer'] },
  scoring: { approved: ['reviewer'], rejected: ['reviewer'] },
  approved: { disbursed: ['reviewer'] },
  rejected: {},
  disbursed: { repaying: ['reviewer'] },
  repaying: { defaulted: ['reviewer'] },
  repaid: {},
  defaulted: { written_off: ['reviewer'] },
  written_off: {}
};

export interface CreateCreditProductInput {
  name: string;
  minPrincipalKobo: number;
  maxPrincipalKobo: number;
  interestBpsAnnual: number;
  termDays: number;
  groupLending?: boolean;
  active?: boolean;
}

export interface ApplyForLoanInput {
  productId: string;
  principalKobo: number;
  purpose?: string;
}

export interface ApplyForGroupLoanInput extends ApplyForLoanInput {
  groupId: string;
}

export interface AddCollateralInput {
  kind: string;
  description: string;
  estimatedValueKobo: number;
}

/** True for admin|lender reviewers (the 'lender' role predates this wave). */
export function isCreditReviewer(actor: CreditActor): boolean {
  return actor.roles.includes('admin') || actor.roles.includes('lender');
}

function requireReviewer(actor: CreditActor): void {
  if (!isCreditReviewer(actor)) {
    throw new ForbiddenException('Only admin or lender reviewers may perform this action');
  }
}

function requireAdmin(actor: CreditActor): void {
  if (!actor.roles.includes('admin')) {
    throw new ForbiddenException('Only administrators may perform this action');
  }
}

function assertKobo(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new BadRequestException(`${field} must be an integer kobo amount >= ${minimum}`);
  }
}

/**
 * Equal-installment amortisation schedule. Interest is the annual bps rate
 * prorated over the term: principal * bps * termDays / (10000 * 365),
 * computed with bigint so the proration is exact in kobo (never floats).
 * The division remainder lands on the final installment.
 */
export function generateCreditSchedule(input: {
  loanId: string;
  principalKobo: number;
  interestBpsAnnual: number;
  termDays: number;
  startIso: string;
}): CreditRepayment[] {
  const principal = BigInt(input.principalKobo);
  const interest =
    (principal * BigInt(input.interestBpsAnnual) * BigInt(input.termDays)) / (10_000n * 365n);
  const total = principal + interest;
  const count = Math.max(1, Math.ceil(input.termDays / 30));
  const installments = BigInt(count);
  const base = total / installments;
  const remainder = total % installments;
  const startMs = Date.parse(input.startIso);
  const schedule: CreditRepayment[] = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = index + 1;
    const amount = base + (sequence === count ? remainder : 0n);
    const dueOffsetDays = Math.floor((sequence * input.termDays) / count);
    schedule.push({
      id: newId('crp'),
      loanId: input.loanId,
      sequence,
      dueAt: new Date(startMs + dueOffsetDays * DAY_MS).toISOString(),
      amountKobo: Number(amount),
      status: 'pending'
    });
  }
  return schedule;
}

/**
 * Read-time late marking: a stored 'pending' repayment past its due date
 * reads as 'late'. No timers mutate rows (platform convention).
 */
export function effectiveRepaymentStatus(
  repayment: CreditRepayment,
  nowMs: number
): CreditRepayment['status'] {
  if (repayment.status === 'pending' && Date.parse(repayment.dueAt) < nowMs) {
    return 'late';
  }
  return repayment.status;
}

@Injectable()
export class CreditService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CREDIT_PRODUCT_REPOSITORY) private readonly products: CreditProductRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(CREDIT_COLLATERAL_REPOSITORY) private readonly collateral: CreditCollateralRepository,
    @Inject(CREDIT_GUARANTOR_REPOSITORY) private readonly guarantors: CreditGuarantorRepository,
    @Inject(CREDIT_GROUP_MEMBER_REPOSITORY) private readonly members: CreditGroupMemberRepository,
    @Inject(CREDIT_SAVINGS_ACCOUNT_REPOSITORY)
    private readonly savingsAccounts: CreditSavingsAccountRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  /* ---------------------------------------------------------- products -- */

  async listProducts(activeOnly = true): Promise<CreditLoanProduct[]> {
    return this.products.find(activeOnly ? { active: true } : {});
  }

  async getProduct(id: string): Promise<CreditLoanProduct> {
    return this.products.getById(id);
  }

  async createProduct(
    input: CreateCreditProductInput,
    actor: CreditActor
  ): Promise<CreditLoanProduct> {
    requireAdmin(actor);
    this.assertProductInput(input);
    const product: CreditLoanProduct = {
      id: newId('cprd'),
      name: input.name,
      minPrincipalKobo: input.minPrincipalKobo,
      maxPrincipalKobo: input.maxPrincipalKobo,
      interestBpsAnnual: input.interestBpsAnnual,
      termDays: input.termDays,
      groupLending: input.groupLending ?? false,
      active: input.active ?? true,
      createdAt: new Date().toISOString()
    };
    const created = await this.products.create(product);
    await this.events.publish(
      'credit.product.created',
      { productId: created.id, name: created.name },
      actor.id
    );
    return created;
  }

  async updateProduct(
    id: string,
    patch: Partial<CreateCreditProductInput>,
    actor: CreditActor
  ): Promise<CreditLoanProduct> {
    requireAdmin(actor);
    const current = await this.products.getById(id);
    const next = { ...current, ...patch };
    this.assertProductInput(next);
    const updated = await this.products.update(id, patch);
    await this.events.publish('credit.product.updated', { productId: id }, actor.id);
    return updated;
  }

  private assertProductInput(
    input: Pick<
      CreditLoanProduct,
      'minPrincipalKobo' | 'maxPrincipalKobo' | 'interestBpsAnnual' | 'termDays'
    >
  ): void {
    assertKobo(input.minPrincipalKobo, 'minPrincipalKobo');
    assertKobo(input.maxPrincipalKobo, 'maxPrincipalKobo');
    if (input.maxPrincipalKobo < input.minPrincipalKobo) {
      throw new BadRequestException('maxPrincipalKobo must be >= minPrincipalKobo');
    }
    if (!Number.isSafeInteger(input.interestBpsAnnual) || input.interestBpsAnnual < 0) {
      throw new BadRequestException('interestBpsAnnual must be a non-negative integer');
    }
    if (!Number.isSafeInteger(input.termDays) || input.termDays < 1) {
      throw new BadRequestException('termDays must be a positive integer');
    }
  }

  /* ------------------------------------------------------------- apply -- */

  async apply(input: ApplyForLoanInput, actor: CreditActor): Promise<CreditLoanApplication> {
    const product = await this.products.getById(input.productId);
    if (product.groupLending) {
      throw new BadRequestException(
        'Group-lending products require the group application endpoint'
      );
    }
    return this.createApplication(input, product, actor);
  }

  /**
   * VSLA/chama group loan: every other group member becomes a co-obligor,
   * recorded as an 'accepted' guarantor row (group membership IS the
   * guarantee in the source suite's chama model).
   */
  async applyForGroup(
    input: ApplyForGroupLoanInput,
    actor: CreditActor
  ): Promise<CreditLoanApplication> {
    const product = await this.products.getById(input.productId);
    if (!product.groupLending) {
      throw new BadRequestException('Product is not enabled for group lending');
    }
    const membership = await this.members.find(input.groupId, actor.id);
    if (!membership) {
      throw new ForbiddenException('Only group members may apply for a group loan');
    }
    const loan = await this.createApplication(input, product, actor, input.groupId);
    const coObligors = (await this.members.listByGroup(input.groupId)).filter(
      (member) => member.userId !== actor.id
    );
    for (const member of coObligors) {
      await this.guarantors.create({
        id: newId('cgar'),
        loanId: loan.id,
        guarantorUserId: member.userId,
        status: 'accepted'
      });
    }
    return loan;
  }

  private async createApplication(
    input: ApplyForLoanInput,
    product: CreditLoanProduct,
    actor: CreditActor,
    groupId?: string
  ): Promise<CreditLoanApplication> {
    if (!product.active) {
      throw new BadRequestException(`Product '${product.name}' is not accepting applications`);
    }
    assertKobo(input.principalKobo, 'principalKobo', 1);
    if (
      input.principalKobo < product.minPrincipalKobo ||
      input.principalKobo > product.maxPrincipalKobo
    ) {
      throw new BadRequestException(
        `principalKobo must be within the product range ${product.minPrincipalKobo}–${product.maxPrincipalKobo} kobo`
      );
    }
    const now = new Date().toISOString();
    const loan: CreditLoanApplication = {
      id: newId('cloan'),
      applicantUserId: actor.id,
      productId: product.id,
      principalKobo: input.principalKobo,
      status: 'draft',
      purpose: input.purpose,
      groupId,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.loans.create(loan);
    await this.events.publish(
      'credit.loan.created',
      {
        loanId: created.id,
        applicantUserId: created.applicantUserId,
        productId: created.productId,
        principalKobo: created.principalKobo,
        groupId: created.groupId
      },
      actor.id
    );
    return created;
  }

  /* -------------------------------------------------------------- reads -- */

  async listLoans(
    actor: CreditActor,
    criteria: CreditLoanCriteria = {}
  ): Promise<CreditLoanApplication[]> {
    if (!isCreditReviewer(actor)) {
      return this.loans.find({ ...criteria, applicantUserId: actor.id });
    }
    return this.loans.find(criteria);
  }

  async getLoan(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    const loan = await this.loans.getById(id);
    await this.assertLoanParty(loan, actor);
    return loan;
  }

  /** Applicant, reviewer, or a guarantor on the loan may read it. */
  private async assertLoanParty(loan: CreditLoanApplication, actor: CreditActor): Promise<void> {
    if (loan.applicantUserId === actor.id || isCreditReviewer(actor)) {
      return;
    }
    const guarantee = await this.guarantors.findOne({
      loanId: loan.id,
      guarantorUserId: actor.id
    });
    if (!guarantee) {
      throw new ForbiddenException('You may only access loans you are a party to');
    }
  }

  /* ------------------------------------------------------- state machine -- */

  async submit(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    const loan = await this.loans.getById(id);
    if (loan.applicantUserId !== actor.id) {
      throw new ForbiddenException('Only the applicant may submit this loan');
    }
    if (loan.status === 'submitted') {
      return loan; // idempotent replay
    }
    return this.transitionLoan(loan, 'submitted', actor);
  }

  /**
   * submitted → scoring: computes the deterministic 5-factor score and
   * persists it on the application (score + factor breakdown JSON).
   */
  async score(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'scoring' && loan.creditScore !== undefined) {
      return loan; // idempotent replay
    }
    this.assertTransition(loan, 'scoring');
    const assessment = await this.computeScore(loan.applicantUserId, loan.id);
    const now = new Date().toISOString();
    const event = this.events.build(
      'credit.loan.scored',
      { loanId: loan.id, score: assessment.score, factors: assessment.factors },
      actor.id
    );
    const updated = await this.loans.updateExpected(
      loan.id,
      {
        status: 'scoring',
        creditScore: assessment.score,
        scoreFactors: assessment.factors,
        updatedAt: now
      },
      { status: loan.status },
      event
    );
    if (this.loans.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.loan.scored',
      entityType: 'credit_loan_application',
      entityId: loan.id,
      metadata: { score: assessment.score }
    });
    return updated;
  }

  /**
   * scoring → approved: generates the equal-installment repayment schedule
   * (interest bps prorated over the term) as one batch.
   */
  async approve(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'approved') {
      return loan; // idempotent replay
    }
    this.assertTransition(loan, 'approved');
    const pendingGuarantors = await this.guarantors.find({ loanId: id, status: 'invited' });
    if (pendingGuarantors.length > 0) {
      throw new BadRequestException(
        'All invited guarantors must accept or decline before approval'
      );
    }
    const product = await this.products.getById(loan.productId);
    const now = new Date().toISOString();
    const updated = await this.transitionLoan(loan, 'approved', actor, {
      decidedAt: now,
      decidedBy: actor.id
    });
    const schedule = generateCreditSchedule({
      loanId: loan.id,
      principalKobo: loan.principalKobo,
      interestBpsAnnual: product.interestBpsAnnual,
      termDays: product.termDays,
      startIso: now
    });
    for (const repayment of schedule) {
      await this.repayments.create(repayment);
    }
    return updated;
  }

  async reject(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'rejected') {
      return loan; // idempotent replay
    }
    return this.transitionLoan(loan, 'rejected', actor, {
      decidedAt: new Date().toISOString(),
      decidedBy: actor.id
    });
  }

  /**
   * approved → disbursed. V1 records the disbursement event only: actual
   * money movement stays with the hardened funds/escrow flow (integration
   * note — no funds-module changes in this wave).
   */
  async disburse(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'disbursed') {
      return loan; // idempotent replay
    }
    return this.transitionLoan(loan, 'disbursed', actor);
  }

  /** disbursed → repaying: activates the repayment calendar. */
  async startRepayment(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'repaying') {
      return loan; // idempotent replay
    }
    return this.transitionLoan(loan, 'repaying', actor);
  }

  /** repaying → defaulted: marks every unpaid installment 'missed'. */
  async defaultLoan(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'defaulted') {
      return loan; // idempotent replay
    }
    this.assertTransition(loan, 'defaulted');
    for (const repayment of await this.repayments.find({ loanId: id })) {
      if (repayment.status === 'pending') {
        await this.repayments.update(repayment.id, { status: 'missed' });
      }
    }
    return this.transitionLoan(loan, 'defaulted', actor);
  }

  /** defaulted → written_off (admin only — balance-sheet write-off). */
  async writeOff(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireAdmin(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'written_off') {
      return loan; // idempotent replay
    }
    return this.transitionLoan(loan, 'written_off', actor);
  }

  private assertTransition(loan: CreditLoanApplication, to: CreditLoanStatus): void {
    const allowed = CREDIT_LOAN_TRANSITIONS[loan.status]?.[to];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid credit loan transition '${loan.status}' -> '${to}' for loan ${loan.id}`
      );
    }
  }

  /**
   * Guarded transition: CAS on the current status (a concurrent transition
   * surfaces as 409), audit entry, and a domain event persisted through the
   * transactional outbox where the repository supports it.
   */
  private async transitionLoan(
    loan: CreditLoanApplication,
    to: CreditLoanStatus,
    actor: CreditActor,
    extra: Partial<CreditLoanApplication> = {}
  ): Promise<CreditLoanApplication> {
    this.assertTransition(loan, to);
    const now = new Date().toISOString();
    const event = this.events.build(
      'credit.loan.status_changed',
      { loanId: loan.id, from: loan.status, to },
      actor.id
    );
    const updated = await this.loans.updateExpected(
      loan.id,
      { ...extra, status: to, updatedAt: now },
      { status: loan.status },
      event
    );
    if (this.loans.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.audit?.record({
      actorId: actor.id,
      action: `credit.loan.${to}`,
      entityType: 'credit_loan_application',
      entityId: loan.id,
      metadata: { from: loan.status, to, principalKobo: loan.principalKobo }
    });
    return updated;
  }

  /* ---------------------------------------------------------- repayments -- */

  /** Schedule with read-time late marking (due_at < now && pending → late). */
  async getSchedule(loanId: string, actor: CreditActor): Promise<CreditRepayment[]> {
    const loan = await this.loans.getById(loanId);
    await this.assertLoanParty(loan, actor);
    const nowMs = Date.now();
    const schedule = await this.repayments.find({ loanId });
    return schedule
      .map((repayment) => ({ ...repayment, status: effectiveRepaymentStatus(repayment, nowMs) }))
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Records an installment payment. Idempotent: an already-paid installment
   * returns its stored state. Paying the final installment flips the loan
   * repaying → repaid (system-driven transition, CAS-guarded).
   */
  async recordPayment(
    loanId: string,
    sequence: number,
    actor: CreditActor
  ): Promise<CreditRepayment> {
    const loan = await this.loans.getById(loanId);
    if (loan.applicantUserId !== actor.id && !isCreditReviewer(actor)) {
      throw new ForbiddenException('Only the borrower or a reviewer may record a payment');
    }
    if (loan.status !== 'repaying') {
      throw new BadRequestException(
        `Loan ${loanId} is not repaying (status '${loan.status}'); payments are only recorded on active repayment`
      );
    }
    const repayment = (await this.repayments.find({ loanId })).find(
      (entry) => entry.sequence === sequence
    );
    if (!repayment) {
      throw new BadRequestException(`Loan ${loanId} has no installment #${sequence}`);
    }
    if (repayment.status === 'paid') {
      return repayment; // idempotent replay
    }
    const now = new Date().toISOString();
    const event = this.events.build(
      'credit.repayment.paid',
      { loanId, sequence, amountKobo: repayment.amountKobo },
      actor.id
    );
    const paid = await this.repayments.updateExpected(
      repayment.id,
      { status: 'paid', paidAt: now, paidAmountKobo: repayment.amountKobo },
      { status: 'pending' },
      event
    );
    if (this.repayments.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    // Final installment paid → the loan closes (repaying → repaid).
    const remaining = await this.repayments.find({ loanId, status: 'pending' });
    if (remaining.length === 0) {
      const current = await this.loans.getById(loanId);
      if (current.status === 'repaying') {
        const closed = await this.loans.updateExpected(
          loanId,
          { status: 'repaid', updatedAt: now },
          { status: 'repaying' }
        );
        await this.events.publish(
          'credit.loan.status_changed',
          { loanId, from: 'repaying', to: 'repaid' },
          actor.id
        );
        await this.audit?.record({
          actorId: actor.id,
          action: 'credit.loan.repaid',
          entityType: 'credit_loan_application',
          entityId: loanId,
          metadata: { from: 'repaying', to: 'repaid', principalKobo: closed.principalKobo }
        });
      }
    }
    return paid;
  }

  /* ---------------------------------------------------------- collateral -- */

  async listCollateral(loanId: string, actor: CreditActor): Promise<CreditCollateral[]> {
    const loan = await this.loans.getById(loanId);
    await this.assertLoanParty(loan, actor);
    return this.collateral.find({ loanId });
  }

  async addCollateral(
    loanId: string,
    input: AddCollateralInput,
    actor: CreditActor
  ): Promise<CreditCollateral> {
    const loan = await this.loans.getById(loanId);
    if (loan.applicantUserId !== actor.id && !isCreditReviewer(actor)) {
      throw new ForbiddenException('Only the borrower or a reviewer may pledge collateral');
    }
    if (!['draft', 'submitted', 'scoring'].includes(loan.status)) {
      throw new BadRequestException(
        `Collateral may only be pledged while the loan is under assessment (status '${loan.status}')`
      );
    }
    assertKobo(input.estimatedValueKobo, 'estimatedValueKobo');
    const entry: CreditCollateral = {
      id: newId('ccol'),
      loanId,
      kind: input.kind,
      description: input.description,
      estimatedValueKobo: input.estimatedValueKobo,
      status: 'pledged'
    };
    const created = await this.collateral.create(entry);
    await this.events.publish(
      'credit.collateral.pledged',
      { collateralId: created.id, loanId, kind: created.kind },
      actor.id
    );
    return created;
  }

  /** pledged → released (e.g. after repayment) — reviewer only. */
  async releaseCollateral(collateralId: string, actor: CreditActor): Promise<CreditCollateral> {
    requireReviewer(actor);
    return this.transitionCollateral(collateralId, 'released', actor);
  }

  /** pledged → claimed — reviewer only, and only on defaulted/written-off loans. */
  async claimCollateral(collateralId: string, actor: CreditActor): Promise<CreditCollateral> {
    requireReviewer(actor);
    const entry = await this.collateral.getById(collateralId);
    const loan = await this.loans.getById(entry.loanId);
    if (loan.status !== 'defaulted' && loan.status !== 'written_off') {
      throw new BadRequestException(
        'Collateral may only be claimed on defaulted or written-off loans'
      );
    }
    return this.transitionCollateral(collateralId, 'claimed', actor);
  }

  private async transitionCollateral(
    collateralId: string,
    to: CreditCollateral['status'],
    actor: CreditActor
  ): Promise<CreditCollateral> {
    const entry = await this.collateral.getById(collateralId);
    if (entry.status === to) {
      return entry; // idempotent replay
    }
    if (entry.status !== 'pledged') {
      throw new BadRequestException(
        `Invalid collateral transition '${entry.status}' -> '${to}' for ${collateralId}`
      );
    }
    const updated = await this.collateral.updateExpected(
      collateralId,
      { status: to },
      { status: 'pledged' }
    );
    await this.events.publish(
      `credit.collateral.${to === 'released' ? 'released' : 'claimed'}`,
      { collateralId, loanId: entry.loanId, to },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: `credit.collateral.${to}`,
      entityType: 'credit_collateral',
      entityId: collateralId,
      metadata: { loanId: entry.loanId }
    });
    return updated;
  }

  /* ---------------------------------------------------------- guarantors -- */

  async listGuarantors(loanId: string, actor: CreditActor): Promise<CreditGuarantor[]> {
    const loan = await this.loans.getById(loanId);
    await this.assertLoanParty(loan, actor);
    return this.guarantors.find({ loanId });
  }

  /** Borrower invites a guarantor while the loan is under assessment. */
  async inviteGuarantor(
    loanId: string,
    guarantorUserId: string,
    actor: CreditActor
  ): Promise<CreditGuarantor> {
    const loan = await this.loans.getById(loanId);
    if (loan.applicantUserId !== actor.id) {
      throw new ForbiddenException('Only the borrower may invite guarantors');
    }
    if (!['draft', 'submitted'].includes(loan.status)) {
      throw new BadRequestException(
        `Guarantors may only be invited while the loan is draft or submitted (status '${loan.status}')`
      );
    }
    if (guarantorUserId === actor.id) {
      throw new BadRequestException('The borrower cannot guarantee their own loan');
    }
    const existing = await this.guarantors.findOne({ loanId, guarantorUserId });
    if (existing) {
      return existing; // idempotent (unique loan+guarantor)
    }
    const guarantor: CreditGuarantor = {
      id: newId('cgar'),
      loanId,
      guarantorUserId,
      status: 'invited'
    };
    const created = await this.guarantors.create(guarantor);
    await this.events.publish(
      'credit.guarantor.invited',
      { guarantorId: created.id, loanId, guarantorUserId },
      actor.id
    );
    return created;
  }

  /** invited → accepted; only the invited guarantor may respond. */
  async acceptGuarantor(guarantorId: string, actor: CreditActor): Promise<CreditGuarantor> {
    return this.respondGuarantor(guarantorId, 'accepted', actor);
  }

  /** invited → declined; only the invited guarantor may respond. */
  async declineGuarantor(guarantorId: string, actor: CreditActor): Promise<CreditGuarantor> {
    return this.respondGuarantor(guarantorId, 'declined', actor);
  }

  private async respondGuarantor(
    guarantorId: string,
    to: 'accepted' | 'declined',
    actor: CreditActor
  ): Promise<CreditGuarantor> {
    const guarantor = await this.guarantors.getById(guarantorId);
    if (guarantor.guarantorUserId !== actor.id) {
      throw new ForbiddenException('Only the invited guarantor may respond');
    }
    if (guarantor.status === to) {
      return guarantor; // idempotent replay
    }
    if (guarantor.status !== 'invited') {
      throw new BadRequestException(
        `Guarantor already responded ('${guarantor.status}') for ${guarantorId}`
      );
    }
    const updated = await this.guarantors.updateExpected(
      guarantorId,
      { status: to },
      { status: 'invited' }
    );
    await this.events.publish(
      `credit.guarantor.${to}`,
      { guarantorId, loanId: guarantor.loanId, to },
      actor.id
    );
    return updated;
  }

  /* ------------------------------------------------------------- scoring -- */

  /** Standalone score preview (no persistence) for a user. */
  async assessApplicant(userId: string): Promise<CreditScoreAssessment> {
    return this.computeScore(userId);
  }

  /**
   * Deterministic 5-factor model (ported from the source suite's
   * credit-scoring service, re-anchored to AgricPlatform data). Each factor
   * contributes 0–200; the score is their sum (0–1000). Pure function of
   * repository state — same data in, same score out, no ML dependency.
   */
  private async computeScore(userId: string, applicationId?: string): Promise<CreditScoreAssessment> {
    const [profile, buyerOrders, sellerOrders, userLoans, memberships] = await Promise.all([
      this.profiles.findByUserId(userId).catch(() => undefined),
      this.orders.find({ buyerId: userId }),
      this.orders.find({ sellerId: userId }),
      this.loans.find({ applicantUserId: userId }),
      this.members.listByUser(userId)
    ]);

    const factors: CreditScoreFactors = {
      repaymentHistory: await this.factorRepaymentHistory(userLoans),
      profileCompleteness: this.factorProfileCompleteness(profile?.completionScore),
      transactionVolume: this.factorTransactionVolume(buyerOrders, sellerOrders),
      guarantorStrength: await this.factorGuarantorStrength(userLoans, applicationId),
      groupStanding: await this.factorGroupStanding(memberships)
    };
    const score = Math.min(
      CREDIT_SCORE_MAX,
      Math.max(
        0,
        factors.repaymentHistory +
          factors.profileCompleteness +
          factors.transactionVolume +
          factors.guarantorStrength +
          factors.groupStanding
      )
    );
    return { userId, score, factors, computedAt: new Date().toISOString() };
  }

  /**
   * Repayment history (0–200): neutral 100 with no terminal history;
   * +25 per repaid loan, −60 per defaulted/written-off loan, −10 per
   * missed installment. Stored statuses only (deterministic).
   */
  private async factorRepaymentHistory(userLoans: CreditLoanApplication[]): Promise<number> {
    let score = 100;
    for (const loan of userLoans) {
      if (loan.status === 'repaid') {
        score += 25;
      } else if (loan.status === 'defaulted' || loan.status === 'written_off') {
        score -= 60;
      }
      const missed = await this.repayments.find({ loanId: loan.id, status: 'missed' });
      score -= 10 * missed.length;
    }
    return this.clampFactor(score);
  }

  /** Farm profile completeness (0–200): profiles.completionScore (0–100) × 2. */
  private factorProfileCompleteness(completionScore: number | undefined): number {
    if (completionScore === undefined) {
      return 0;
    }
    return this.clampFactor(Math.round(completionScore * 2));
  }

  /**
   * Transaction volume (0–200): marketplace order history as buyer or
   * seller; completed/delivered orders weigh 25, others 5.
   */
  private factorTransactionVolume(
    buyerOrders: readonly { id: string; status: string }[],
    sellerOrders: readonly { id: string; status: string }[]
  ): number {
    const seen = new Map<string, string>();
    for (const order of [...buyerOrders, ...sellerOrders]) {
      seen.set(order.id, order.status);
    }
    let score = 0;
    for (const status of seen.values()) {
      score += status === 'completed' || status === 'delivered' ? 25 : 5;
    }
    return this.clampFactor(score);
  }

  /**
   * Guarantor strength (0–200): accepted guarantors backing the applicant —
   * for the application being scored when given, else across the
   * applicant's loans. 100 per accepted guarantor.
   */
  private async factorGuarantorStrength(
    userLoans: CreditLoanApplication[],
    applicationId?: string
  ): Promise<number> {
    if (applicationId) {
      const accepted = await this.guarantors.find({ loanId: applicationId, status: 'accepted' });
      return this.clampFactor(accepted.length * 100);
    }
    let count = 0;
    for (const loan of userLoans) {
      const accepted = await this.guarantors.find({ loanId: loan.id, status: 'accepted' });
      count += accepted.length;
    }
    return this.clampFactor(count * 100);
  }

  /**
   * Group standing (0–200): VSLA/chama membership (40 per group, cap 80),
   * leadership (40), and group savings health (40 any balance / 80 at
   * ≥ ₦1,000 across the member's groups).
   */
  private async factorGroupStanding(
    memberships: readonly { groupId: string; userId: string; role: string }[]
  ): Promise<number> {
    let score = Math.min(80, memberships.length * 40);
    if (memberships.some((membership) => membership.role === 'leader')) {
      score += 40;
    }
    let groupBalanceKobo = 0;
    for (const membership of memberships) {
      const account = await this.savingsAccounts.findOne({ groupId: membership.groupId });
      if (account) {
        groupBalanceKobo += account.balanceKobo;
      }
    }
    score += groupBalanceKobo >= 100_000 ? 80 : groupBalanceKobo > 0 ? 40 : 0;
    return this.clampFactor(score);
  }

  private clampFactor(value: number): number {
    return Math.min(CREDIT_FACTOR_MAX, Math.max(0, value));
  }

  /* ----------------------------------------------------------- portfolio -- */

  /**
   * Portfolio-at-risk report (admin|lender). PAR-N = outstanding kobo on
   * active loans with any repayment overdue ≥ N days ÷ total outstanding
   * kobo, returned as integer basis points (float-free). Outstanding is the
   * sum of unpaid installment amounts on disbursed|repaying loans;
   * defaulted stock is reported separately.
   */
  async portfolio(actor: CreditActor): Promise<CreditPortfolioReport> {
    requireReviewer(actor);
    const nowMs = Date.now();
    const loans = await this.loans.all();
    let activeLoans = 0;
    let defaultedLoans = 0;
    let outstandingKobo = 0;
    let defaultedKobo = 0;
    let par30Kobo = 0;
    let par60Kobo = 0;
    let par90Kobo = 0;
    for (const loan of loans) {
      if (loan.status !== 'disbursed' && loan.status !== 'repaying' && loan.status !== 'defaulted') {
        continue;
      }
      const schedule = await this.repayments.find({ loanId: loan.id });
      const unpaid = schedule.filter((repayment) => repayment.status !== 'paid');
      const unpaidKobo = unpaid.reduce((sum, repayment) => sum + repayment.amountKobo, 0);
      if (loan.status === 'defaulted') {
        defaultedLoans += 1;
        defaultedKobo += unpaidKobo;
        continue;
      }
      activeLoans += 1;
      outstandingKobo += unpaidKobo;
      let maxOverdueDays = 0;
      for (const repayment of unpaid) {
        const overdueMs = nowMs - Date.parse(repayment.dueAt);
        if (overdueMs > 0) {
          maxOverdueDays = Math.max(maxOverdueDays, Math.floor(overdueMs / DAY_MS));
        }
      }
      if (maxOverdueDays >= 30) par30Kobo += unpaidKobo;
      if (maxOverdueDays >= 60) par60Kobo += unpaidKobo;
      if (maxOverdueDays >= 90) par90Kobo += unpaidKobo;
    }
    const ratioBps = (part: number): number =>
      outstandingKobo > 0 ? Math.round((part * 10_000) / outstandingKobo) : 0;
    return {
      generatedAt: new Date(nowMs).toISOString(),
      totalLoans: loans.length,
      activeLoans,
      defaultedLoans,
      outstandingKobo,
      defaultedKobo,
      par30Kobo,
      par60Kobo,
      par90Kobo,
      par30Bps: ratioBps(par30Kobo),
      par60Bps: ratioBps(par60Kobo),
      par90Bps: ratioBps(par90Kobo)
    };
  }
}
