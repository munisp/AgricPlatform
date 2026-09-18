import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleInit
} from '@nestjs/common';
import {
  CREDIT_FACTOR_MAX,
  CREDIT_SCORE_MAX,
  type CreditCollateral,
  type CreditGuarantor,
  type CreditLoanApplication,
  type CreditLoanProduct,
  type CreditLoanRestructure,
  type CreditLoanStatus,
  type CreditPortfolioReport,
  type CreditRepayment,
  type CreditScoreAssessment,
  type CreditScoreFactors,
  type User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import {
  CREDIT_COLLATERAL_REPOSITORY,
  CREDIT_GUARANTOR_REPOSITORY,
  CREDIT_GROUP_MEMBER_REPOSITORY,
  CREDIT_GROUP_REPOSITORY,
  CREDIT_LOAN_REPOSITORY,
  CREDIT_PRODUCT_REPOSITORY,
  CREDIT_REPAYMENT_REPOSITORY,
  CREDIT_RESTRUCTURE_REPOSITORY,
  CREDIT_SAVINGS_ACCOUNT_REPOSITORY,
  CREDIT_SAVINGS_TRANSACTION_REPOSITORY,
  ORDER_REPOSITORY,
  PROFILE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CreditCollateralRepository,
  CreditGroupMemberRepository,
  CreditGroupRepository,
  CreditGuarantorRepository,
  CreditLoanCriteria,
  CreditLoanRepository,
  CreditProductRepository,
  CreditRepaymentRepository,
  CreditRestructureRepository,
  CreditSavingsAccountRepository,
  CreditSavingsTransactionRepository
} from '../../database/repositories/credit-suite.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
// Stage 27 (innovation #20): shared pure PAR accumulation — see ./par.ts.
import { computeParMetrics, type ParLoanFact } from './par.js';

/** Actor driving a credit mutation: the applicant or a reviewer (admin|lender). */
export type CreditActor = Pick<User, 'id' | 'roles'>;

type LoanParty = 'applicant' | 'reviewer';

const DAY_MS = 86_400_000;

/**
 * Credit loan lifecycle state machine (Wave CREDIT + Wave-2 design gaps):
 *   draft → submitted → scoring → approved | rejected
 *   approved → disbursed → repaying → repaid | defaulted → written_off
 *   repaying → consolidated (V-30: folded into a top-up loan)
 *   defaulted → repaying    (V-05: cure — a payment on a defaulted loan
 *                            re-activates it and its missed installments)
 * `repaid` is system-driven (last installment fully covered) and never
 * accepted by the generic transition guard; `consolidated` is driven by
 * the top-up approval path only. Every transition is a guarded
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
  repaying: { defaulted: ['reviewer'], consolidated: ['reviewer'] },
  repaid: {},
  defaulted: { written_off: ['reviewer'], repaying: ['reviewer', 'applicant'] },
  written_off: {},
  consolidated: {}
};

/**
 * V-30 exposure control: a borrower may hold at most this many ACTIVE
 * loans (approved/disbursed/repaying) and the aggregate outstanding
 * balance across active + defaulted loans plus the requested principal may
 * not exceed the ceiling. Platform-wide conservative defaults; per-product
 * ranges still apply on top.
 */
export const CREDIT_MAX_ACTIVE_LOANS = 3;
export const CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO = 50_000_000;

/** Loan statuses that count against the active-loan count cap (V-30). */
const EXPOSURE_COUNT_STATUSES: ReadonlySet<CreditLoanStatus> = new Set([
  'approved',
  'disbursed',
  'repaying'
]);

/** Loan statuses whose unpaid balances count toward the exposure ceiling. */
const EXPOSURE_BALANCE_STATUSES: ReadonlySet<CreditLoanStatus> = new Set([
  'approved',
  'disbursed',
  'repaying',
  'defaulted'
]);

/** V-03 review flag value set by the crop-failure grace subscriber. */
export const CREDIT_REVIEW_CROP_FAILURE = 'crop_failure';

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
  /**
   * V-03: optional link to the financed plot / planting. Persisted on the
   * application so a farms planting-failure event can trigger the grace
   * path (aging suspension + review flag) on the linked loan.
   */
  plotId?: string;
  plantingId?: string;
}

export interface ApplyForGroupLoanInput extends ApplyForLoanInput {
  groupId: string;
}

/** V-30 top-up consolidation: a new application that folds a live loan. */
export interface ApplyForTopUpInput extends ApplyForLoanInput {
  /** The applicant's own repaying loan to consolidate. */
  consolidatesLoanId: string;
}

export interface AddCollateralInput {
  kind: string;
  description: string;
  estimatedValueKobo: number;
  /**
   * V-31: when the collateral is a warehouse-pledged receipt, record the
   * pledge / receipt references so a later claim can drive the warehouse
   * liquidation path (see the credit.collateral.claimed event contract).
   */
  warehousePledgeId?: string;
  warehouseReceiptId?: string;
}

/** V-04 restructure terms. */
export interface RestructureLoanInput {
  /** Replacement tenor in days (must be a positive integer). */
  termDays: number;
  /** Replacement annual rate; defaults to the product's current rate. */
  interestBpsAnnual?: number;
  /** Free-text reason (audited, pinned on the restructure record). */
  reason: string;
}

/** V-05 settlement-for-less input. */
export interface SettleLoanInput {
  /**
   * Cash actually received, integer kobo, 0..outstanding. The remainder is
   * written down (platform:loan_losses debit) in the same balanced entry.
   */
  settlementKobo: number;
}

/** True for admin|lender reviewers (the 'lender' role predates this wave). */
export function isCreditReviewer(actor: CreditActor): boolean {
  return actor.roles.includes('admin') || actor.roles.includes('lender');
}

/**
 * Application statuses that constitute an ACTIVE lender linkage for the
 * V-61 score-preview scope: the application is in the pipeline a lender
 * reviewer could action. Terminal outcomes (rejected/repaid/defaulted/
 * written_off) require a decidedBy binding instead. Drafts are the
 * applicant's alone.
 */
const SCORE_LINKED_ACTIVE_STATUSES: ReadonlySet<CreditLoanStatus> = new Set([
  'submitted',
  'scoring',
  'approved',
  'disbursed',
  'repaying'
]);

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
  /** Schedule generation (V-04): 1 for the approval-time schedule. */
  scheduleVersion?: number;
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
      // V-29: the balance accumulates from 0; a concrete (non-null) value is
      // required so partial payments can CAS on the running total.
      paidAmountKobo: 0,
      scheduleVersion: input.scheduleVersion ?? 1,
      status: 'pending'
    });
  }
  return schedule;
}

/** Unpaid remainder of one installment (integer kobo). */
export function installmentOutstandingKobo(repayment: CreditRepayment): number {
  if (repayment.status === 'paid' || repayment.status === 'superseded') {
    return 0;
  }
  return repayment.amountKobo - (repayment.paidAmountKobo ?? 0);
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
export class CreditService implements OnModuleInit {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CREDIT_PRODUCT_REPOSITORY) private readonly products: CreditProductRepository,
    @Inject(CREDIT_LOAN_REPOSITORY) private readonly loans: CreditLoanRepository,
    @Inject(CREDIT_REPAYMENT_REPOSITORY) private readonly repayments: CreditRepaymentRepository,
    @Inject(CREDIT_COLLATERAL_REPOSITORY) private readonly collateral: CreditCollateralRepository,
    @Inject(CREDIT_GUARANTOR_REPOSITORY) private readonly guarantors: CreditGuarantorRepository,
    @Inject(CREDIT_GROUP_REPOSITORY) private readonly groups: CreditGroupRepository,
    @Inject(CREDIT_GROUP_MEMBER_REPOSITORY) private readonly members: CreditGroupMemberRepository,
    @Inject(CREDIT_SAVINGS_ACCOUNT_REPOSITORY)
    private readonly savingsAccounts: CreditSavingsAccountRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(CREDIT_RESTRUCTURE_REPOSITORY)
    private readonly restructures: CreditRestructureRepository,
    @Inject(CREDIT_SAVINGS_TRANSACTION_REPOSITORY)
    private readonly savingsTransactions: CreditSavingsTransactionRepository,
    /**
     * Wave-2 money movements (V-05 settlement write-down, V-28 guarantor
     * liability/settlement legs) post through the double-entry ledger. The
     * dependency is optional for construction (unit tests) but the posting
     * paths fail closed when it is absent — a money-moving operation never
     * silently skips its legs.
     */
    @Optional() private readonly ledger?: LedgerService,
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
    const group = await this.groups.getById(input.groupId);
    if (group.status === 'dissolved') {
      throw new BadRequestException(
        `Group ${input.groupId} is dissolved; no new group loans may be drawn on it`
      );
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

  /**
   * V-30 exposure control: rejects the application (400) when the applicant
   * already holds CREDIT_MAX_ACTIVE_LOANS active loans, or when the
   * applicant's aggregate outstanding balance (active + defaulted loans)
   * plus the requested principal would exceed CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO.
   * `additionalKobo` is the NET new exposure (a top-up consolidation passes
   * only its top-up principal — the consolidated balance is already counted).
   */
  private async assertExposureAllowance(
    applicantUserId: string,
    additionalKobo: number
  ): Promise<void> {
    const mine = await this.loans.find({ applicantUserId });
    const active = mine.filter((loan) => EXPOSURE_COUNT_STATUSES.has(loan.status));
    if (active.length >= CREDIT_MAX_ACTIVE_LOANS) {
      throw new BadRequestException(
        `EXPOSURE_CAP: applicant already holds ${active.length} active loans (cap ${CREDIT_MAX_ACTIVE_LOANS})`
      );
    }
    let exposureKobo = 0;
    for (const loan of mine) {
      if (!EXPOSURE_BALANCE_STATUSES.has(loan.status)) {
        continue;
      }
      if (loan.status === 'approved') {
        // Approved but not yet disbursed: the full principal is committed.
        exposureKobo += loan.principalKobo;
        continue;
      }
      const schedule = await this.repayments.find({ loanId: loan.id });
      for (const repayment of schedule) {
        exposureKobo += installmentOutstandingKobo(repayment);
      }
    }
    if (exposureKobo + additionalKobo > CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO) {
      throw new BadRequestException(
        `EXPOSURE_CEILING: outstanding exposure ${exposureKobo} kobo + requested ` +
          `${additionalKobo} kobo exceeds the aggregate ceiling of ${CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO} kobo`
      );
    }
  }

  /**
   * V-30 top-up consolidation: the borrower applies for additional principal
   * on a product while folding an existing REPAYING loan into the new one.
   * The fold happens AT APPROVAL (see approve): the old loan transitions
   * repaying → consolidated (CAS), its open installments are superseded and
   * the new schedule covers top-up principal + the old outstanding balance
   * — one atomic consolidation instead of two parallel loans.
   */
  async applyForTopUp(input: ApplyForTopUpInput, actor: CreditActor): Promise<CreditLoanApplication> {
    const product = await this.products.getById(input.productId);
    if (product.groupLending) {
      throw new BadRequestException('Top-up consolidation is not available for group products');
    }
    const existing = await this.loans.getById(input.consolidatesLoanId);
    if (existing.applicantUserId !== actor.id) {
      throw new ForbiddenException('You may only consolidate your own loans');
    }
    if (existing.status !== 'repaying') {
      throw new BadRequestException(
        `TOP_UP_STATE: loan ${existing.id} is '${existing.status}'; only a repaying loan can be consolidated`
      );
    }
    const already = await this.loans.findOne({ consolidatesLoanId: existing.id });
    if (already) {
      throw new ConflictException(
        `TOP_UP_EXISTS: loan ${existing.id} is already consolidated by application ${already.id}`
      );
    }
    return this.createApplication(input, product, actor, undefined, existing.id);
  }

  private async createApplication(
    input: ApplyForLoanInput,
    product: CreditLoanProduct,
    actor: CreditActor,
    groupId?: string,
    consolidatesLoanId?: string
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
    // V-30 exposure control: active-loan count cap + aggregate exposure
    // ceiling, checked at application time (not just at decision time).
    await this.assertExposureAllowance(actor.id, input.principalKobo);
    const now = new Date().toISOString();
    const loan: CreditLoanApplication = {
      id: newId('cloan'),
      applicantUserId: actor.id,
      productId: product.id,
      principalKobo: input.principalKobo,
      status: 'draft',
      purpose: input.purpose,
      groupId,
      plotId: input.plotId,
      plantingId: input.plantingId,
      consolidatesLoanId,
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
    if (loan.status === 'approved' && !loan.consolidatesLoanId) {
      return loan; // idempotent replay
    }
    const product = await this.products.getById(loan.productId);
    const now = new Date().toISOString();
    let updated = loan;
    if (loan.status !== 'approved') {
      this.assertTransition(loan, 'approved');
      const pendingGuarantors = await this.guarantors.find({ loanId: id, status: 'invited' });
      if (pendingGuarantors.length > 0) {
        throw new BadRequestException(
          'All invited guarantors must accept or decline before approval'
        );
      }
      updated = await this.transitionLoan(loan, 'approved', actor, {
        decidedAt: now,
        decidedBy: actor.id
      });
    }
    let schedulePrincipal = loan.principalKobo;
    if (loan.consolidatesLoanId) {
      // V-30 top-up consolidation: fold the source loan into this one —
      // claim the source loan (CAS repaying → consolidated), supersede its
      // open installments, record the fold, and schedule this loan over
      // top-up principal + the source's outstanding balance. Retry-safe:
      // an already-approved application resumes the fold here.
      schedulePrincipal = await this.consolidateSourceLoan(loan, actor, now);
    }
    // Schedule generation is idempotent: a retried approval (or a resumed
    // consolidation) does not duplicate repayment rows.
    const existingSchedule = await this.repayments.find({ loanId: loan.id });
    if (existingSchedule.length === 0) {
      const schedule = generateCreditSchedule({
        loanId: loan.id,
        principalKobo: schedulePrincipal,
        interestBpsAnnual: product.interestBpsAnnual,
        termDays: product.termDays,
        startIso: now
      });
      for (const repayment of schedule) {
        await this.repayments.create(repayment);
      }
    }
    return updated;
  }

  /**
   * V-30: folds the repaying source loan into the top-up application.
   * Claim-first: the source loan is CAS-claimed (repaying → consolidated)
   * BEFORE any schedule mutation, so a concurrent consolidation/payment
   * loses cleanly with a 409. Retry-safe: when a previous attempt already
   * consolidated the source (crash between claim and schedule generation),
   * the fold is adopted and the outstanding is recomputed from the pinned
   * restructure record instead of re-superseding rows.
   * Returns the schedule principal (top-up principal + source outstanding).
   */
  private async consolidateSourceLoan(
    loan: CreditLoanApplication,
    actor: CreditActor,
    now: string
  ): Promise<number> {
    const source = await this.loans.getById(loan.consolidatesLoanId!);
    if (source.applicantUserId !== loan.applicantUserId) {
      throw new BadRequestException('TOP_UP_OWNER: a top-up can only consolidate the same borrower’s loan');
    }
    let outstandingKobo: number;
    if (source.status === 'repaying') {
      const sourceSchedule = await this.repayments.find({ loanId: source.id });
      const open = sourceSchedule.filter(
        (repayment) => repayment.status === 'pending' || repayment.status === 'missed'
      );
      outstandingKobo = open.reduce((sum, repayment) => sum + installmentOutstandingKobo(repayment), 0);
      const event = this.events.build(
        'credit.loan.consolidated',
        { loanId: source.id, consolidatedByLoanId: loan.id, outstandingKobo },
        actor.id
      );
      await this.loans.updateExpected(
        source.id,
        { status: 'consolidated', updatedAt: now },
        { status: 'repaying', updatedAt: source.updatedAt },
        event
      );
      if (this.loans.transactionalOutbox) {
        this.events.emit(event);
      } else {
        await this.events.persist(event);
      }
      // Supersede the source's open schedule rows (immutable audit history).
      for (const repayment of open) {
        await this.repayments.update(repayment.id, { status: 'superseded' });
      }
      // Pin the fold as a restructure record on the SOURCE loan.
      await this.restructures.create({
        id: newId('crst'),
        loanId: source.id,
        version:
          (await this.restructures.find({ loanId: source.id })).reduce(
            (max, row) => Math.max(max, row.version),
            0
          ) + 1,
        reason: `top-up consolidation into application ${loan.id}`,
        outstandingKobo,
        supersededSchedule: open.map((repayment) => ({
          repaymentId: repayment.id,
          sequence: repayment.sequence,
          dueAt: repayment.dueAt,
          amountKobo: repayment.amountKobo,
          paidAmountKobo: repayment.paidAmountKobo ?? 0
        })),
        newInstallmentCount: 0,
        createdBy: actor.id,
        createdAt: now
      });
    } else if (source.status === 'consolidated') {
      // Retry adoption: the source was already folded by an earlier attempt
      // of THIS application — recompute the carried balance from the pinned
      // fold record instead of re-mutating anything.
      const folds = (await this.restructures.find({ loanId: source.id })).filter((row) =>
        row.reason.endsWith(loan.id)
      );
      const fold = folds.sort((a, b) => b.version - a.version)[0];
      if (!fold) {
        throw new ConflictException(
          `TOP_UP_CONFLICT: loan ${source.id} was consolidated by a different application`
        );
      }
      outstandingKobo = fold.outstandingKobo;
    } else {
      throw new BadRequestException(
        `TOP_UP_STATE: loan ${source.id} is '${source.status}'; only a repaying loan can be consolidated`
      );
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.loan.consolidated',
      entityType: 'credit_loan_application',
      entityId: source.id,
      metadata: { consolidatedByLoanId: loan.id, outstandingKobo }
    });
    return loan.principalKobo + outstandingKobo;
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

  /**
   * repaying → defaulted: marks every unpaid installment 'missed' and
   * issues GUARANTOR DEMANDS (V-28): every accepted guarantor is called for
   * a computed share of the outstanding balance (largest-remainder split,
   * deterministic by guarantor id). Each demand is a CAS accepted → called
   * plus a `credit.guarantor.demand_issued` notification event; a replayed
   * default skips guarantors already called.
   */
  async defaultLoan(id: string, actor: CreditActor): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    const loan = await this.loans.getById(id);
    if (loan.status === 'defaulted') {
      return loan; // idempotent replay
    }
    this.assertTransition(loan, 'defaulted');
    let outstandingKobo = 0;
    for (const repayment of await this.repayments.find({ loanId: id })) {
      if (repayment.status === 'pending') {
        await this.repayments.update(repayment.id, { status: 'missed' });
        outstandingKobo += installmentOutstandingKobo(repayment);
      }
    }
    const updated = await this.transitionLoan(loan, 'defaulted', actor);
    await this.issueGuarantorDemands(loan, outstandingKobo, actor);
    return updated;
  }

  /**
   * V-28: calls every accepted guarantor for their share of the defaulted
   * outstanding balance. Shares use a largest-remainder split over the
   * guarantor list sorted by id, so the split is deterministic and sums
   * exactly to the outstanding balance.
   */
  private async issueGuarantorDemands(
    loan: CreditLoanApplication,
    outstandingKobo: number,
    actor: CreditActor
  ): Promise<void> {
    const accepted = (await this.guarantors.find({ loanId: loan.id, status: 'accepted' })).sort(
      (a, b) => a.id.localeCompare(b.id)
    );
    if (accepted.length === 0 || outstandingKobo <= 0) {
      return;
    }
    const base = Math.floor(outstandingKobo / accepted.length);
    const remainder = outstandingKobo - base * accepted.length;
    const now = new Date().toISOString();
    for (const [index, guarantor] of accepted.entries()) {
      const share = base + (index < remainder ? 1 : 0);
      try {
        const called = await this.guarantors.updateExpected(
          guarantor.id,
          { status: 'called', demandAmountKobo: share, demandedAt: now },
          { status: 'accepted' }
        );
        await this.events.publish(
          'credit.guarantor.demand_issued',
          {
            guarantorId: called.id,
            loanId: loan.id,
            guarantorUserId: called.guarantorUserId,
            demandAmountKobo: share
          },
          actor.id
        );
        await this.audit?.record({
          actorId: actor.id,
          action: 'credit.guarantor.demand_issued',
          entityType: 'credit_guarantor',
          entityId: called.id,
          metadata: { loanId: loan.id, demandAmountKobo: share }
        });
      } catch (error) {
        // CAS race (concurrent default replay already called this guarantor):
        // the winner's demand stands — never double-demand.
        if (error instanceof ConflictException) {
          continue;
        }
        throw error;
      }
    }
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

  /**
   * Schedule with read-time late marking (due_at < now && pending → late).
   * V-03 grace: while the loan's aging is suspended (reviewFlag set by the
   * crop-failure subscriber), pending installments are returned as stored —
   * they do not age into 'late' until a reviewer resolves the review.
   */
  async getSchedule(loanId: string, actor: CreditActor): Promise<CreditRepayment[]> {
    const loan = await this.loans.getById(loanId);
    await this.assertLoanParty(loan, actor);
    const nowMs = Date.now();
    const agingSuspended = loan.agingSuspendedAt !== undefined;
    const schedule = await this.repayments.find({ loanId });
    return schedule
      .map((repayment) =>
        agingSuspended
          ? repayment
          : { ...repayment, status: effectiveRepaymentStatus(repayment, nowMs) }
      )
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Records an installment payment. V-29: amount-parameterised — a payment
   * covers `amountKobo` of the installment's outstanding balance (default:
   * the full remaining balance, the pre-V-29 behaviour); overpayment beyond
   * the remaining balance is REJECTED (400, V-57 pattern — cash never
   * silently vanishes from the books). The installment flips to 'paid' only
   * when fully covered, and the loan closes (repaying → repaid) only when
   * every installment is fully covered.
   *
   * V-05 cure: a payment against a DEFAULTED loan first cures it — the loan
   * CAS-transitions defaulted → repaying and its missed installments
   * re-activate (missed → pending) — then applies the payment normally.
   *
   * Idempotent: an already-paid installment returns its stored state. The
   * balance accumulation is CAS-guarded (expected paidAmountKobo + status),
   * so concurrent partial payments serialise instead of losing updates.
   */
  async recordPayment(
    loanId: string,
    sequence: number,
    actor: CreditActor,
    amountKobo?: number
  ): Promise<CreditRepayment> {
    let loan = await this.loans.getById(loanId);
    if (loan.applicantUserId !== actor.id && !isCreditReviewer(actor)) {
      throw new ForbiddenException('Only the borrower or a reviewer may record a payment');
    }
    if (loan.status === 'defaulted') {
      loan = await this.cureLoan(loan, actor);
    }
    if (loan.status !== 'repaying') {
      throw new BadRequestException(
        `Loan ${loanId} is not repaying (status '${loan.status}'); payments are only recorded on active repayment`
      );
    }
    // V-04/V-30: after a restructure/consolidation the superseded rows and
    // the replacement schedule share sequence numbers — the OPEN row
    // (pending/missed) wins; candidates[0] is the fallback so a fully
    // closed installment still replays idempotently.
    const candidates = (await this.repayments.find({ loanId })).filter(
      (entry) => entry.sequence === sequence
    );
    const repayment =
      candidates.find((entry) => entry.status === 'pending' || entry.status === 'missed') ??
      candidates[0];
    if (!repayment) {
      throw new BadRequestException(`Loan ${loanId} has no installment #${sequence}`);
    }
    if (repayment.status === 'paid') {
      return repayment; // idempotent replay
    }
    if (repayment.status === 'superseded') {
      throw new BadRequestException(
        `Installment #${sequence} of loan ${loanId} was superseded by a restructure; pay against the current schedule`
      );
    }
    const paidSoFar = repayment.paidAmountKobo ?? 0;
    const outstanding = repayment.amountKobo - paidSoFar;
    const payment = amountKobo === undefined ? outstanding : amountKobo;
    assertKobo(payment, 'amountKobo', 1);
    if (payment > outstanding) {
      throw new BadRequestException(
        `OVERPAYMENT_REJECTED: installment #${sequence} of loan ${loanId} has ${outstanding} kobo outstanding; ` +
          `a ${payment} kobo payment would exceed it`
      );
    }
    const now = new Date().toISOString();
    const newPaid = paidSoFar + payment;
    const fullyCovered = newPaid >= repayment.amountKobo;
    const event = this.events.build(
      'credit.repayment.paid',
      { loanId, sequence, amountKobo: payment, fullyCovered },
      actor.id
    );
    const paid = await this.repayments.updateExpected(
      repayment.id,
      {
        status: fullyCovered ? 'paid' : repayment.status,
        paidAmountKobo: newPaid,
        ...(fullyCovered ? { paidAt: now } : {})
      },
      { status: repayment.status, paidAmountKobo: paidSoFar },
      event
    );
    if (this.repayments.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    if (!fullyCovered) {
      return paid; // partial payment: the loan stays open
    }
    // Final installment fully covered → the loan closes (repaying → repaid).
    const remaining = (await this.repayments.find({ loanId, status: 'pending' })).filter(
      (entry) => installmentOutstandingKobo(entry) > 0
    );
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

  /**
   * V-05 cure: defaulted → repaying with installment re-activation
   * (missed → pending). CAS-guarded; a concurrent cure is adopted (the
   * re-read loan is already repaying) instead of failing the payer.
   */
  private async cureLoan(
    loan: CreditLoanApplication,
    actor: CreditActor
  ): Promise<CreditLoanApplication> {
    const now = new Date().toISOString();
    const event = this.events.build(
      'credit.loan.status_changed',
      { loanId: loan.id, from: 'defaulted', to: 'repaying', cured: true },
      actor.id
    );
    try {
      const cured = await this.loans.updateExpected(
        loan.id,
        { status: 'repaying', updatedAt: now },
        { status: 'defaulted', updatedAt: loan.updatedAt },
        event
      );
      if (this.loans.transactionalOutbox) {
        this.events.emit(event);
      } else {
        await this.events.persist(event);
      }
      // Re-activate missed installments so they accept payments again.
      for (const repayment of await this.repayments.find({ loanId: loan.id, status: 'missed' })) {
        await this.repayments.updateExpected(
          repayment.id,
          { status: 'pending' },
          { status: 'missed' }
        );
      }
      await this.audit?.record({
        actorId: actor.id,
        action: 'credit.loan.cured',
        entityType: 'credit_loan_application',
        entityId: loan.id,
        metadata: { from: 'defaulted', to: 'repaying' }
      });
      return cured;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Adopt-on-conflict: a concurrent cure won — re-read and proceed.
        const current = await this.loans.getById(loan.id);
        if (current.status === 'repaying') {
          return current;
        }
      }
      throw error;
    }
  }

  /**
   * V-05 settlement-for-less (reviewer): closes a defaulted loan for less
   * than the outstanding balance. Posts ONE balanced ledger entry —
   *   debit  platform:cash          settlementKobo (cash actually received)
   *   debit  platform:loan_losses   writeDownKobo  (the write-down)
   *   credit member:<applicant>:loans_receivable  outstandingKobo
   * (the cash leg is omitted when settlementKobo is 0) — then transitions
   * defaulted → written_off with the settlement split recorded on the loan.
   * Idempotent by the entity-derived key `credit-settlement:<loanId>`; a
   * replay returns the stored loan without re-posting.
   */
  async settleDefaultedLoan(
    loanId: string,
    input: SettleLoanInput,
    actor: CreditActor
  ): Promise<CreditLoanApplication> {
    requireReviewer(actor);
    if (!this.ledger) {
      // Fail closed: a settlement moves money and MUST post its legs.
      throw new ServiceUnavailableException('Ledger service is unavailable; settlement refused');
    }
    const loan = await this.loans.getById(loanId);
    if (loan.status === 'written_off' && loan.settledAmountKobo !== undefined) {
      return loan; // idempotent replay of a settled write-off
    }
    if (loan.status !== 'defaulted') {
      throw new BadRequestException(
        `SETTLEMENT_STATE: loan ${loanId} is '${loan.status}'; only a defaulted loan can be settled for less`
      );
    }
    const schedule = await this.repayments.find({ loanId });
    const outstandingKobo = schedule.reduce(
      (sum, repayment) => sum + installmentOutstandingKobo(repayment),
      0
    );
    assertKobo(input.settlementKobo, 'settlementKobo', 0);
    if (input.settlementKobo > outstandingKobo) {
      throw new BadRequestException(
        `OVERPAYMENT_REJECTED: loan ${loanId} has ${outstandingKobo} kobo outstanding; ` +
          `settlement of ${input.settlementKobo} kobo exceeds it`
      );
    }
    const writeDownKobo = outstandingKobo - input.settlementKobo;
    if (writeDownKobo === 0) {
      throw new BadRequestException(
        'Settlement covers the full outstanding balance; record the payments instead (cure path)'
      );
    }
    const receivableCode = `member:${loan.applicantUserId}:loans_receivable`;
    const postings = [
      ...(input.settlementKobo > 0
        ? [
            {
              accountCode: 'platform:cash',
              direction: 'debit' as const,
              amountKobo: input.settlementKobo
            }
          ]
        : []),
      {
        accountCode: 'platform:loan_losses',
        direction: 'debit' as const,
        amountKobo: writeDownKobo
      },
      {
        accountCode: receivableCode,
        direction: 'credit' as const,
        amountKobo: outstandingKobo
      }
    ];
    await this.ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
    await this.ledger.ensureAccount({ code: 'platform:loan_losses', type: 'expense' });
    await this.ledger.ensureAccount({
      code: receivableCode,
      type: 'asset',
      ownerId: loan.applicantUserId
    });
    await this.ledger.postEntry(
      {
        idempotencyKey: `credit-settlement:${loanId}`,
        referenceType: 'credit_loan_application',
        referenceId: loanId,
        description: `Credit settlement-for-less on defaulted loan ${loanId}`,
        postings
      },
      actor.id
    );
    const now = new Date().toISOString();
    const updated = await this.transitionLoan(loan, 'written_off', actor, {
      settledAmountKobo: input.settlementKobo,
      writeDownKobo,
      decidedAt: now,
      decidedBy: actor.id
    });
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.loan.settled',
      entityType: 'credit_loan_application',
      entityId: loanId,
      metadata: { settlementKobo: input.settlementKobo, writeDownKobo, outstandingKobo }
    });
    return updated;
  }

  /* --------------------------------------------------------- restructure -- */

  /**
   * V-04 loan restructure (reviewer): regenerates a REPAYING loan's
   * schedule from its outstanding balance.
   *   - claim-first CAS: the loan row is claimed with an updatedAt
   *     compare-and-set BEFORE any schedule mutation, so two concurrent
   *     restructures serialise — the loser gets a 409 and never touches the
   *     schedule (unit-tested);
   *   - the old OPEN installments (pending/missed) are marked 'superseded'
   *     (immutable audit history — paid rows are untouched);
   *   - an append-only credit.loan_restructures row pins the replaced
   *     schedule (snapshot) and the carry-forward balance;
   *   - the replacement schedule is generated over the outstanding balance
   *     with the next schedule_version;
   *   - credit-score factor recompute hook: the borrower's score is
   *     recomputed at restructure time, persisted on the loan and pinned on
   *     the restructure record (scoreAfter);
   *   - a crop-failure review flag (V-03) is cleared — the restructure IS
   *     the review resolution — and aging resumes on the new schedule.
   */
  async restructureLoan(
    loanId: string,
    input: RestructureLoanInput,
    actor: CreditActor
  ): Promise<{ loan: CreditLoanApplication; restructure: CreditLoanRestructure }> {
    requireReviewer(actor);
    if (!Number.isSafeInteger(input.termDays) || input.termDays < 1) {
      throw new BadRequestException('termDays must be a positive integer');
    }
    if (!input.reason.trim()) {
      throw new BadRequestException('A restructure reason is required (audit trail)');
    }
    const loan = await this.loans.getById(loanId);
    if (loan.status !== 'repaying') {
      throw new BadRequestException(
        `RESTRUCTURE_STATE: loan ${loanId} is '${loan.status}'; only a repaying loan can be restructured`
      );
    }
    const product = await this.products.getById(loan.productId);
    const interestBpsAnnual = input.interestBpsAnnual ?? product.interestBpsAnnual;
    if (!Number.isSafeInteger(interestBpsAnnual) || interestBpsAnnual < 0) {
      throw new BadRequestException('interestBpsAnnual must be a non-negative integer');
    }
    const schedule = await this.repayments.find({ loanId });
    const open = schedule.filter(
      (repayment) => repayment.status === 'pending' || repayment.status === 'missed'
    );
    const outstandingKobo = open.reduce(
      (sum, repayment) => sum + installmentOutstandingKobo(repayment),
      0
    );
    if (outstandingKobo <= 0) {
      throw new BadRequestException(`RESTRUCTURE_EMPTY: loan ${loanId} has no open balance`);
    }
    // Claim-first CAS on (status, updatedAt): a concurrent restructure or
    // payment-driven close that moved the row loses here with a 409 BEFORE
    // any installment is superseded. The claimed updatedAt is strictly
    // greater than the read one (updatedAt is the CAS discriminator — two
    // claims in the same wall-clock millisecond must still serialise).
    const now = new Date(Math.max(Date.now(), Date.parse(loan.updatedAt) + 1)).toISOString();
    const claimEvent = this.events.build(
      'credit.loan.restructure_claimed',
      { loanId, outstandingKobo, reason: input.reason },
      actor.id
    );
    await this.loans.updateExpected(
      loanId,
      { updatedAt: now },
      { status: 'repaying', updatedAt: loan.updatedAt },
      claimEvent
    );
    if (this.loans.transactionalOutbox) {
      this.events.emit(claimEvent);
    } else {
      await this.events.persist(claimEvent);
    }
    // The claim is held: supersede the old open schedule and pin the record.
    for (const repayment of open) {
      await this.repayments.update(repayment.id, { status: 'superseded' });
    }
    const version =
      (await this.restructures.find({ loanId })).reduce(
        (max, row) => Math.max(max, row.version),
        0
      ) + 1;
    // Score-factor recompute hook (V-04): the borrower's score is recomputed
    // against post-restructure state and pinned on the restructure record.
    const assessment = await this.computeScore(loan.applicantUserId, loanId);
    const restructure = await this.restructures.create({
      id: newId('crst'),
      loanId,
      version,
      reason: input.reason.trim(),
      outstandingKobo,
      supersededSchedule: open.map((repayment) => ({
        repaymentId: repayment.id,
        sequence: repayment.sequence,
        dueAt: repayment.dueAt,
        amountKobo: repayment.amountKobo,
        paidAmountKobo: repayment.paidAmountKobo ?? 0
      })),
      newInstallmentCount: Math.max(1, Math.ceil(input.termDays / 30)),
      scoreAfter: assessment.score,
      createdBy: actor.id,
      createdAt: now
    });
    const replacement = generateCreditSchedule({
      loanId,
      principalKobo: outstandingKobo,
      interestBpsAnnual,
      termDays: input.termDays,
      startIso: now,
      scheduleVersion: version + 1
    });
    for (const repayment of replacement) {
      await this.repayments.create(repayment);
    }
    // Persist the recomputed score and clear a resolved crop-failure review.
    await this.loans.update(loanId, {
      creditScore: assessment.score,
      scoreFactors: assessment.factors,
      reviewFlag: undefined,
      agingSuspendedAt: undefined,
      updatedAt: new Date().toISOString()
    });
    await this.events.publish(
      'credit.loan.restructured',
      {
        loanId,
        restructureId: restructure.id,
        version,
        outstandingKobo,
        newInstallmentCount: replacement.length,
        scoreAfter: assessment.score
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.loan.restructured',
      entityType: 'credit_loan_application',
      entityId: loanId,
      metadata: { version, outstandingKobo, reason: input.reason.trim() }
    });
    return { loan: await this.loans.getById(loanId), restructure };
  }

  /** Restructure history for a loan (party-visible, newest first). */
  async listRestructures(loanId: string, actor: CreditActor): Promise<CreditLoanRestructure[]> {
    const loan = await this.loans.getById(loanId);
    await this.assertLoanParty(loan, actor);
    return (await this.restructures.find({ loanId })).sort((a, b) => b.version - a.version);
  }

  /* --------------------------------------------------- guarantor demands -- */

  /**
   * V-28: the guarantor accepts a demand (called → liable). Accepting posts
   * the liability leg — debit member:<guarantor>:guarantee_receivable /
   * credit member:<borrower>:loans_receivable (the platform's claim moves
   * from the borrower to the guarantor) — idempotent by the entity-derived
   * key `credit-guarantor-liability:<guarantorId>`.
   */
  async acceptGuarantorDemand(guarantorId: string, actor: CreditActor): Promise<CreditGuarantor> {
    const guarantor = await this.guarantors.getById(guarantorId);
    if (guarantor.guarantorUserId !== actor.id) {
      throw new ForbiddenException('Only the called guarantor may accept the liability');
    }
    if (guarantor.status === 'liable') {
      return guarantor; // idempotent replay
    }
    if (guarantor.status !== 'called') {
      throw new BadRequestException(
        `GUARANTOR_DEMAND_STATE: guarantor ${guarantorId} is '${guarantor.status}'; only a called demand can be accepted`
      );
    }
    if (!this.ledger) {
      throw new ServiceUnavailableException(
        'Ledger service is unavailable; liability acceptance refused'
      );
    }
    const loan = await this.loans.getById(guarantor.loanId);
    const demandKobo = guarantor.demandAmountKobo ?? 0;
    if (demandKobo <= 0) {
      throw new BadRequestException(`Guarantor demand ${guarantorId} carries no amount`);
    }
    const guaranteeReceivable = `member:${guarantor.guarantorUserId}:guarantee_receivable`;
    const borrowerReceivable = `member:${loan.applicantUserId}:loans_receivable`;
    await this.ledger.ensureAccount({
      code: guaranteeReceivable,
      type: 'asset',
      ownerId: guarantor.guarantorUserId
    });
    await this.ledger.ensureAccount({
      code: borrowerReceivable,
      type: 'asset',
      ownerId: loan.applicantUserId
    });
    await this.ledger.postEntry(
      {
        idempotencyKey: `credit-guarantor-liability:${guarantorId}`,
        referenceType: 'credit_guarantor',
        referenceId: guarantorId,
        description: `Guarantor liability accepted for loan ${loan.id}`,
        postings: [
          { accountCode: guaranteeReceivable, direction: 'debit', amountKobo: demandKobo },
          { accountCode: borrowerReceivable, direction: 'credit', amountKobo: demandKobo }
        ]
      },
      actor.id
    );
    const now = new Date().toISOString();
    const updated = await this.guarantors.updateExpected(
      guarantorId,
      { status: 'liable', liabilityAcceptedAt: now },
      { status: 'called' }
    );
    await this.events.publish(
      'credit.guarantor.liable',
      { guarantorId, loanId: guarantor.loanId, demandAmountKobo: demandKobo },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.guarantor.liable',
      entityType: 'credit_guarantor',
      entityId: guarantorId,
      metadata: { loanId: guarantor.loanId, demandAmountKobo: demandKobo }
    });
    return updated;
  }

  /**
   * V-28: settles an accepted demand (liable → settled). Posts the
   * settlement leg — debit platform:cash / credit the guarantor's
   * guarantee_receivable — idempotent by `credit-guarantor-settlement:<id>`.
   *
   * Savings debit is CONSENT-GATED: only when the caller passes a
   * `consentRef` (the recorded consent reference) is the guarantor's
   * savings account debited for the amount (ref `guarantor-settlement:<id>`,
   * idempotent replay via the savings ref). Without a consent reference the
   * settlement records cash received out-of-band — savings are never
   * touched.
   */
  async settleGuarantorDemand(
    guarantorId: string,
    actor: CreditActor,
    options: { consentRef?: string } = {}
  ): Promise<CreditGuarantor> {
    const guarantor = await this.guarantors.getById(guarantorId);
    if (guarantor.guarantorUserId !== actor.id && !isCreditReviewer(actor)) {
      throw new ForbiddenException('Only the guarantor or a reviewer may settle a demand');
    }
    if (guarantor.status === 'settled') {
      return guarantor; // idempotent replay
    }
    if (guarantor.status !== 'liable') {
      throw new BadRequestException(
        `GUARANTOR_DEMAND_STATE: guarantor ${guarantorId} is '${guarantor.status}'; only a liable demand can be settled`
      );
    }
    if (!this.ledger) {
      throw new ServiceUnavailableException('Ledger service is unavailable; settlement refused');
    }
    const demandKobo = guarantor.demandAmountKobo ?? 0;
    if (demandKobo <= 0) {
      throw new BadRequestException(`Guarantor demand ${guarantorId} carries no amount`);
    }
    if (options.consentRef !== undefined) {
      // Recorded consent required: without it the savings account is never
      // debited (V-28 consent boundary).
      if (!options.consentRef.trim()) {
        throw new BadRequestException('consentRef must be a non-empty recorded consent reference');
      }
      await this.debitGuarantorSavings(guarantor, demandKobo);
    }
    const guaranteeReceivable = `member:${guarantor.guarantorUserId}:guarantee_receivable`;
    await this.ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
    await this.ledger.ensureAccount({
      code: guaranteeReceivable,
      type: 'asset',
      ownerId: guarantor.guarantorUserId
    });
    await this.ledger.postEntry(
      {
        idempotencyKey: `credit-guarantor-settlement:${guarantorId}`,
        referenceType: 'credit_guarantor',
        referenceId: guarantorId,
        description: `Guarantor demand settled for ${guarantorId}`,
        postings: [
          { accountCode: 'platform:cash', direction: 'debit', amountKobo: demandKobo },
          { accountCode: guaranteeReceivable, direction: 'credit', amountKobo: demandKobo }
        ]
      },
      actor.id
    );
    const now = new Date().toISOString();
    const updated = await this.guarantors.updateExpected(
      guarantorId,
      { status: 'settled', settledAt: now, consentRef: options.consentRef },
      { status: 'liable' }
    );
    await this.events.publish(
      'credit.guarantor.settled',
      {
        guarantorId,
        loanId: guarantor.loanId,
        settledAmountKobo: demandKobo,
        savingsDebited: options.consentRef !== undefined
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'credit.guarantor.settled',
      entityType: 'credit_guarantor',
      entityId: guarantorId,
      metadata: {
        loanId: guarantor.loanId,
        settledAmountKobo: demandKobo,
        consentRef: options.consentRef
      }
    });
    return updated;
  }

  /**
   * Consent-gated guarantor savings debit (V-28): withdraws the demand
   * amount from the guarantor's personal savings account through the
   * guarded balance-CAS path (applyTransaction), idempotent by ref
   * `guarantor-settlement:<guarantorId>`. Insufficient balance → 400, and
   * the settlement is refused before any ledger posting.
   */
  private async debitGuarantorSavings(
    guarantor: CreditGuarantor,
    amountKobo: number
  ): Promise<void> {
    const account = await this.savingsAccounts.findOne({ userId: guarantor.guarantorUserId });
    if (!account) {
      throw new BadRequestException(
        `Guarantor ${guarantor.guarantorUserId} has no savings account to debit`
      );
    }
    const ref = `guarantor-settlement:${guarantor.id}`;
    const existing = await this.savingsTransactions.findOne({ ref });
    if (existing) {
      return; // idempotent replay: the debit already happened for this demand
    }
    const current = await this.savingsAccounts.getById(account.id);
    if (current.balanceKobo < amountKobo) {
      throw new BadRequestException(
        `Guarantor savings balance ${current.balanceKobo} kobo cannot cover the ${amountKobo} kobo demand`
      );
    }
    const now = new Date().toISOString();
    const event = this.events.build(
      'credit.savings.withdrawn',
      { accountId: account.id, amountKobo, ref, reason: 'guarantor_settlement' },
      guarantor.guarantorUserId
    );
    await this.savingsAccounts.applyTransaction(
      account.id,
      { balanceKobo: current.balanceKobo },
      { balanceKobo: current.balanceKobo - amountKobo, updatedAt: now },
      {
        id: newId('ctxn'),
        accountId: account.id,
        direction: 'withdrawal',
        amountKobo,
        balanceAfterKobo: current.balanceKobo - amountKobo,
        ref,
        createdAt: now
      },
      event
    );
    if (this.savingsAccounts.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
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
      warehousePledgeId: input.warehousePledgeId,
      warehouseReceiptId: input.warehouseReceiptId,
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
    /**
     * Event contract (V-31) — `credit.collateral.claimed` payload:
     *   { collateralId, loanId, to: 'claimed', kind, estimatedValueKobo,
     *     warehousePledgeId?, warehouseReceiptId? }
     * The warehouse references are present when the collateral row
     * references a warehouse pledge/receipt (set at pledge time). The
     * warehouse-module subscriber (pack W2-C3) consumes this event to drive
     * the pledge release/liquidation path for receipt-backed collateral;
     * collateral without warehouse references is credit-local and the
     * subscriber ignores it. `credit.collateral.released` carries the same
     * shape with to: 'released'.
     */
    await this.events.publish(
      `credit.collateral.${to === 'released' ? 'released' : 'claimed'}`,
      {
        collateralId,
        loanId: entry.loanId,
        to,
        kind: entry.kind,
        estimatedValueKobo: entry.estimatedValueKobo,
        warehousePledgeId: entry.warehousePledgeId,
        warehouseReceiptId: entry.warehouseReceiptId
      },
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

  /**
   * Score-preview authorisation (V-61): self and admin always pass; a LENDER
   * passes only with a real application linkage to the target user — an
   * application this lender decided, or one still in an active pipeline
   * state the lender could action. This mirrors the credit-passport
   * consent-scoped disclosure doctrine: without it any onboarded lender
   * could build an unauthorised credit bureau over the whole farmer base.
   */
  async assertScoreReadAccess(actor: CreditActor, userId: string): Promise<void> {
    if (actor.id === userId || actor.roles.includes('admin')) {
      return;
    }
    if (actor.roles.includes('lender')) {
      const applications = await this.loans.find({ applicantUserId: userId });
      const linked = applications.some(
        (loan) => loan.decidedBy === actor.id || SCORE_LINKED_ACTIVE_STATUSES.has(loan.status)
      );
      if (linked) {
        return;
      }
    }
    throw new ForbiddenException('You may only preview your own score');
  }

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

  /* -------------------------------------- crop-failure grace (V-03) -- */

  /**
   * V-03: subscribe to the farms planting-failure event.
   *
   * Event contract (`farms.planting.status_changed` with payload.to === 'failed',
   * emitted by farms.service.ts updatePlantingStatus — the emission is owned by
   * the farms pack):
   *   { plantingId: string; plotId: string; farmerId: string;
   *     cropType: string; failureReason: string; occurredAt: string }
   *
   * Every ACTIVE loan (disbursed/repaying) linked to the failed planting or
   * its plot (plotId/plantingId persisted at application time, V-03) is
   * flagged for review and its installment aging is suspended: pending
   * installments stop reading as 'late' until a reviewer resolves the flag
   * (the restructure path, V-04, clears it). This is the GRACE trigger —
   * the restructure itself stays a reviewer decision.
   */
  onModuleInit(): void {
    this.events.on('farms.planting.status_changed', (event) => void this.onPlantingFailed(event));
  }

  /** Subscriber body; also directly callable (integration tests). */
  async onPlantingFailed(event: DomainEvent): Promise<void> {
    const payload = event.payload as {
      plantingId?: string;
      plotId?: string;
      farmerId?: string;
      ownerId?: string; // farms contract: ownerId IS the farmer identity
      cropType?: string;
      failureReason?: string;
      occurredAt?: string;
      to?: string; // status_changed envelope — only 'failed' transitions apply
    };
    if (payload.to !== 'failed') {
      return; // not a failure transition
    }
    if (!payload.plantingId && !payload.plotId) {
      return; // fail closed: no linkage keys, nothing to match
    }
    const candidates = new Map<string, CreditLoanApplication>();
    for (const criteria of [
      payload.plantingId ? { plantingId: payload.plantingId } : undefined,
      payload.plotId ? { plotId: payload.plotId } : undefined
    ]) {
      if (!criteria) {
        continue;
      }
      for (const loan of await this.loans.find(criteria)) {
        candidates.set(loan.id, loan);
      }
    }
    const now = new Date().toISOString();
    for (const loan of candidates.values()) {
      if (loan.status !== 'disbursed' && loan.status !== 'repaying') {
        continue; // only live loans need the grace trigger
      }
      if (loan.reviewFlag === CREDIT_REVIEW_CROP_FAILURE) {
        continue; // idempotent replay of the failure event
      }
      try {
        await this.loans.updateExpected(
          loan.id,
          { reviewFlag: CREDIT_REVIEW_CROP_FAILURE, agingSuspendedAt: now, updatedAt: now },
          { status: loan.status, updatedAt: loan.updatedAt }
        );
      } catch (error) {
        // CAS race with a concurrent transition — adopt-on-conflict: re-read
        // and skip if the loan moved on (the next event/review will re-flag).
        if (error instanceof ConflictException) {
          continue;
        }
        throw error;
      }
      await this.events.publish(
        'credit.loan.flagged_for_review',
        {
          loanId: loan.id,
          applicantUserId: loan.applicantUserId,
          reviewFlag: CREDIT_REVIEW_CROP_FAILURE,
          plantingId: payload.plantingId,
          plotId: payload.plotId,
          cropType: payload.cropType,
          failureReason: payload.failureReason,
          agingSuspendedAt: now
        },
        event.actorId
      );
      await this.audit?.record({
        actorId: event.actorId ?? 'system',
        action: 'credit.loan.flagged_for_review',
        entityType: 'credit_loan_application',
        entityId: loan.id,
        metadata: {
          reviewFlag: CREDIT_REVIEW_CROP_FAILURE,
          plantingId: payload.plantingId,
          plotId: payload.plotId,
          failureReason: payload.failureReason
        }
      });
    }
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
    // Single PAR implementation (Stage 27, innovation #20): the accumulation
    // lives in ./par.ts so the analytics lender-scorecard assembly reuses the
    // exact same formula instead of a drifting copy.
    const facts: ParLoanFact[] = [];
    for (const loan of loans) {
      facts.push({
        status: loan.status,
        repayments: await this.repayments.find({ loanId: loan.id })
      });
    }
    return {
      generatedAt: new Date(nowMs).toISOString(),
      totalLoans: loans.length,
      ...computeParMetrics(facts, nowMs)
    };
  }
}
