import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CreditLoanProduct, CreditRepayment, Profile, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCreditCollateralRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGuarantorRepository,
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository,
  InMemoryCreditLoanRepository,
  InMemoryCreditProductRepository,
  InMemoryCreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import {
  CreditService,
  effectiveRepaymentStatus,
  generateCreditSchedule
} from './credit.service.js';

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const otherFarmer: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };

const PRODUCT: CreditLoanProduct = {
  id: 'cprd-seasonal',
  name: 'Seasonal input loan',
  minPrincipalKobo: 100_000,
  maxPrincipalKobo: 5_000_000,
  interestBpsAnnual: 1200,
  termDays: 180,
  groupLending: false,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

function makeService(options: {
  loans?: InMemoryCreditLoanRepository;
  repayments?: InMemoryCreditRepaymentRepository;
  profiles?: InMemoryProfileRepository;
} = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const transactions = createInMemoryCreditSavingsTransactionRepository();
  const savingsAccounts = createInMemoryCreditSavingsAccountRepository(transactions);
  const loans = options.loans ?? createInMemoryCreditLoanRepository();
  const repayments = options.repayments ?? createInMemoryCreditRepaymentRepository();
  const collateral = createInMemoryCreditCollateralRepository();
  const guarantors = createInMemoryCreditGuarantorRepository();
  const members = createInMemoryCreditGroupMemberRepository();
  const profiles = options.profiles ?? new InMemoryProfileRepository();
  const orders = new InMemoryOrderRepository();
  const service = new CreditService(
    events,
    new InMemoryCreditProductRepository([PRODUCT]),
    loans,
    repayments,
    collateral,
    guarantors,
    members,
    savingsAccounts,
    profiles,
    orders
  );
  return { service, events, loans, repayments, collateral, guarantors, members, profiles, orders };
}

/** Drives a loan from draft to `repaying` through the reviewer pipeline. */
async function repayingLoan(service: CreditService, applicant = farmer) {
  const draft = await service.apply(
    { productId: PRODUCT.id, principalKobo: 1_000_000, purpose: 'Fertiliser' },
    applicant
  );
  await service.submit(draft.id, applicant);
  await service.score(draft.id, lender);
  await service.approve(draft.id, admin);
  await service.disburse(draft.id, lender);
  return service.startRepayment(draft.id, lender);
}

describe('CreditService products', () => {
  it('creates and lists products (admin only)', async () => {
    const { service } = makeService();
    await expect(
      service.createProduct(
        {
          name: 'X',
          minPrincipalKobo: 0,
          maxPrincipalKobo: 1,
          interestBpsAnnual: 0,
          termDays: 30
        },
        farmer
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    const created = await service.createProduct(
      {
        name: 'Equipment lease',
        minPrincipalKobo: 500_000,
        maxPrincipalKobo: 10_000_000,
        interestBpsAnnual: 1500,
        termDays: 365
      },
      admin
    );
    expect(created.active).toBe(true);
    const listed = await service.listProducts();
    expect(listed.map((product) => product.id)).toContain(created.id);
  });

  it('rejects inverted ticket ranges and non-integer kobo', async () => {
    const { service } = makeService();
    await expect(
      service.createProduct(
        {
          name: 'Bad',
          minPrincipalKobo: 200,
          maxPrincipalKobo: 100,
          interestBpsAnnual: 100,
          termDays: 30
        },
        admin
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.apply({ productId: PRODUCT.id, principalKobo: 100.5 }, farmer)
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CreditService lifecycle state machine', () => {
  it('walks draft → repaid through every guarded transition', async () => {
    const { service } = makeService();
    const draft = await service.apply(
      { productId: PRODUCT.id, principalKobo: 1_000_000 },
      farmer
    );
    expect(draft.status).toBe('draft');
    expect((await service.submit(draft.id, farmer)).status).toBe('submitted');
    const scored = await service.score(draft.id, lender);
    expect(scored.status).toBe('scoring');
    expect(scored.creditScore).toBeGreaterThanOrEqual(0);
    expect(scored.scoreFactors).toBeDefined();
    expect((await service.approve(draft.id, admin)).status).toBe('approved');
    expect((await service.disburse(draft.id, lender)).status).toBe('disbursed');
    expect((await service.startRepayment(draft.id, lender)).status).toBe('repaying');
    const schedule = await service.getSchedule(draft.id, farmer);
    expect(schedule.length).toBe(6); // ceil(180/30)
    for (const installment of schedule) {
      await service.recordPayment(draft.id, installment.sequence, farmer);
    }
    const closed = await service.getLoan(draft.id, farmer);
    expect(closed.status).toBe('repaid');
  });

  it('rejects illegal transitions (draft → approved, repaid → disbursed)', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await expect(service.approve(draft.id, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.disburse(draft.id, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.startRepayment(draft.id, admin)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('supports the rejection branch with decidedAt/decidedBy', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await service.submit(draft.id, farmer);
    await service.score(draft.id, lender);
    const rejected = await service.reject(draft.id, lender);
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedBy).toBe(lender.id);
    expect(rejected.decidedAt).toBeDefined();
    // Terminal: nothing further may happen.
    await expect(service.approve(draft.id, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('serialises concurrent transitions via CAS — one wins, one 409s', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await service.submit(draft.id, farmer);
    await service.score(draft.id, lender);
    // Both transitions read status 'scoring'; the in-memory sync CAS body
    // serialises them exactly like the guarded SQL UPDATE — exactly one
    // commits, the other surfaces a 409 Conflict.
    const outcomes = await Promise.allSettled([
      service.approve(draft.id, admin),
      service.reject(draft.id, lender)
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    const final = await service.getLoan(draft.id, admin);
    expect(['approved', 'rejected']).toContain(final.status);
  });

  it('scopes transitions: only the applicant submits, only reviewers decide', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await expect(service.submit(draft.id, otherFarmer)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await service.submit(draft.id, farmer);
    await expect(service.score(draft.id, farmer)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.approve(draft.id, farmer)).rejects.toBeInstanceOf(ForbiddenException);
    // lender is a reviewer
    await service.score(draft.id, lender);
    expect((await service.approve(draft.id, lender)).status).toBe('approved');
  });

  it('requires admin (not lender) for write-off after default', async () => {
    const { service } = makeService();
    const loan = await repayingLoan(service);
    expect((await service.defaultLoan(loan.id, lender)).status).toBe('defaulted');
    await expect(service.writeOff(loan.id, lender)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await service.writeOff(loan.id, admin)).status).toBe('written_off');
    const schedule = await service.getSchedule(loan.id, admin);
    expect(schedule.every((installment) => installment.status === 'missed')).toBe(true);
  });

  it('lists only own loans for farmers, all for reviewers', async () => {
    const { service } = makeService();
    await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await service.apply({ productId: PRODUCT.id, principalKobo: 600_000 }, otherFarmer);
    expect((await service.listLoans(farmer)).length).toBe(1);
    expect((await service.listLoans(lender)).length).toBe(2);
    await expect(service.getLoan((await service.listLoans(otherFarmer))[0]!.id, farmer))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CreditService repayment schedule math', () => {
  it('prorates annual bps interest exactly in kobo (bigint, no floats)', () => {
    // 1_000_000 kobo at 1200 bps (12%) over 180 days:
    // interest = floor(1_000_000 * 1200 * 180 / (10000 * 365)) = 59_178 kobo.
    const schedule = generateCreditSchedule({
      loanId: 'cloan-x',
      principalKobo: 1_000_000,
      interestBpsAnnual: 1200,
      termDays: 180,
      startIso: '2026-02-01T00:00:00.000Z'
    });
    expect(schedule.length).toBe(6);
    const total = schedule.reduce((sum, entry) => sum + entry.amountKobo, 0);
    expect(total).toBe(1_059_178);
    // Equal installments; the 4-kobo remainder lands on the last one.
    expect(schedule.slice(0, 5).every((entry) => entry.amountKobo === 176_529)).toBe(true);
    expect(schedule[5]!.amountKobo).toBe(176_533);
    // Due dates spread evenly: 30/60/…/180 days out.
    expect(schedule[0]!.dueAt).toBe('2026-03-03T00:00:00.000Z');
    expect(Date.parse(schedule[5]!.dueAt) - Date.parse('2026-02-01T00:00:00.000Z')).toBe(
      180 * 86_400_000
    );
  });

  it('handles zero-interest and sub-30-day terms', () => {
    const schedule = generateCreditSchedule({
      loanId: 'cloan-y',
      principalKobo: 99,
      interestBpsAnnual: 0,
      termDays: 14,
      startIso: '2026-02-01T00:00:00.000Z'
    });
    expect(schedule.length).toBe(1);
    expect(schedule[0]!.amountKobo).toBe(99);
  });

  it('generates the schedule on approval and records idempotent payments', async () => {
    const { service } = makeService();
    const loan = await repayingLoan(service);
    const schedule = await service.getSchedule(loan.id, farmer);
    const paid = await service.recordPayment(loan.id, 1, farmer);
    expect(paid.status).toBe('paid');
    expect(paid.paidAmountKobo).toBe(schedule[0]!.amountKobo);
    // Replay: same installment returns the stored payment, no double-posting.
    const replay = await service.recordPayment(loan.id, 1, farmer);
    expect(replay.paidAt).toBe(paid.paidAt);
    // Payments only while repaying.
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await expect(service.recordPayment(draft.id, 1, farmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('marks overdue pending installments late at read time (no timers)', () => {
    const overdue: CreditRepayment = {
      id: 'crp-1',
      loanId: 'cloan-1',
      sequence: 1,
      dueAt: '2026-01-01T00:00:00.000Z',
      amountKobo: 1000,
      status: 'pending'
    };
    expect(effectiveRepaymentStatus(overdue, Date.parse('2026-02-01T00:00:00.000Z'))).toBe('late');
    expect(effectiveRepaymentStatus(overdue, Date.parse('2025-12-01T00:00:00.000Z'))).toBe(
      'pending'
    );
    expect(
      effectiveRepaymentStatus({ ...overdue, status: 'paid' }, Date.parse('2026-02-01T00:00:00.000Z'))
    ).toBe('paid');
  });
});

describe('CreditService scoring', () => {
  it('is deterministic: same data, same score and factors', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await service.submit(draft.id, farmer);
    const first = await service.score(draft.id, lender);
    const second = await service.assessApplicant(farmer.id);
    expect(first.creditScore).toBe(second.score);
    expect(first.scoreFactors).toEqual(second.factors);
  });

  it('covers all five factors and stays within 0–1000', async () => {
    const profiles = new InMemoryProfileRepository([
      {
        userId: farmer.id,
        location: { state: 'Kano', lga: 'Kano Municipal' },
        farmingInterests: ['maize'],
        valueChains: ['grains'],
        completionScore: 80,
        badges: []
      } satisfies Profile
    ]);
    const { service, orders, members } = makeService({ profiles });
    await orders.create({
      id: 'ord-1',
      listingId: 'lst-1',
      buyerId: farmer.id,
      sellerId: 'user-seller',
      quantity: 2,
      totalNaira: 5000,
      status: 'completed',
      escrowRequired: false,
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    await members.add({
      groupId: 'cgrp-1',
      userId: farmer.id,
      role: 'leader',
      joinedAt: '2026-01-01T00:00:00.000Z'
    });
    const assessment = await service.assessApplicant(farmer.id);
    expect(assessment.factors.repaymentHistory).toBe(100); // neutral, no history
    expect(assessment.factors.profileCompleteness).toBe(160); // 80 × 2
    expect(assessment.factors.transactionVolume).toBe(25); // one completed order
    expect(assessment.factors.groupStanding).toBe(80); // member(40) + leader(40)
    expect(assessment.score).toBe(365);
    expect(assessment.score).toBeLessThanOrEqual(1000);
  });

  it('rewards repaid history and penalises defaults', async () => {
    const { service } = makeService();
    // One full cycle to repaid.
    await repayingLoan(service);
    const loans = await service.listLoans(farmer);
    const schedule = await service.getSchedule(loans[0]!.id, farmer);
    for (const installment of schedule) {
      await service.recordPayment(loans[0]!.id, installment.sequence, farmer);
    }
    const afterRepaid = await service.assessApplicant(farmer.id);
    expect(afterRepaid.factors.repaymentHistory).toBe(125); // 100 + 25
    // A second loan that defaults drags the factor down.
    const second = await repayingLoan(service);
    await service.defaultLoan(second.id, lender);
    const afterDefault = await service.assessApplicant(farmer.id);
    // 100 + 25 (repaid) − 60 (default) − 10 × 6 missed = 5.
    expect(afterDefault.factors.repaymentHistory).toBe(5);
  });
});

describe('CreditService portfolio (PAR)', () => {
  it('computes par30/60/90 ratios in integer bps', async () => {
    const now = Date.now();
    const day = 86_400_000;
    const loans = new InMemoryCreditLoanRepository([
      {
        id: 'cloan-a',
        applicantUserId: farmer.id,
        productId: PRODUCT.id,
        principalKobo: 1_000_000,
        status: 'repaying',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'cloan-b',
        applicantUserId: otherFarmer.id,
        productId: PRODUCT.id,
        principalKobo: 1_000_000,
        status: 'repaying',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'cloan-c',
        applicantUserId: otherFarmer.id,
        productId: PRODUCT.id,
        principalKobo: 500_000,
        status: 'defaulted',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    const iso = (ms: number) => new Date(ms).toISOString();
    const repayments = new InMemoryCreditRepaymentRepository([
      // cloan-a: 45 days overdue on 400_000 unpaid.
      {
        id: 'crp-a1',
        loanId: 'cloan-a',
        sequence: 1,
        dueAt: iso(now - 45 * day),
        amountKobo: 400_000,
        status: 'pending'
      },
      // cloan-b: 95 days overdue on 300_000 unpaid.
      {
        id: 'crp-b1',
        loanId: 'cloan-b',
        sequence: 1,
        dueAt: iso(now - 95 * day),
        amountKobo: 300_000,
        status: 'pending'
      },
      // cloan-c (defaulted): excluded from outstanding, counted as default.
      {
        id: 'crp-c1',
        loanId: 'cloan-c',
        sequence: 1,
        dueAt: iso(now - 120 * day),
        amountKobo: 500_000,
        status: 'missed'
      }
    ]);
    const { service } = makeService({ loans, repayments });
    const report = await service.portfolio(lender);
    expect(report.outstandingKobo).toBe(700_000);
    expect(report.defaultedKobo).toBe(500_000);
    expect(report.defaultedLoans).toBe(1);
    expect(report.par30Kobo).toBe(700_000); // both loans ≥ 30 days overdue
    expect(report.par60Kobo).toBe(300_000); // only cloan-b ≥ 60
    expect(report.par90Kobo).toBe(300_000); // only cloan-b ≥ 90
    expect(report.par30Bps).toBe(10_000);
    expect(report.par60Bps).toBe(Math.round((300_000 * 10_000) / 700_000));
    expect(report.par90Bps).toBe(report.par60Bps);
  });

  it('restricts the portfolio report to reviewers', async () => {
    const { service } = makeService();
    await expect(service.portfolio(farmer)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.portfolio(admin)).resolves.toBeDefined();
  });
});

describe('CreditService collateral + guarantors', () => {
  it('pledges collateral while under assessment and releases it (reviewer)', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    const entry = await service.addCollateral(
      draft.id,
      { kind: 'land_title', description: 'Family plot, Kano', estimatedValueKobo: 2_000_000 },
      farmer
    );
    expect(entry.status).toBe('pledged');
    expect((await service.releaseCollateral(entry.id, lender)).status).toBe('released');
    // Terminal: cannot claim a released asset.
    await expect(service.claimCollateral(entry.id, lender)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('refuses collateral once the loan is repaying', async () => {
    const { service } = makeService();
    const loan = await repayingLoan(service);
    // Too late to pledge once repaying.
    await expect(
      service.addCollateral(
        loan.id,
        { kind: 'tractor', description: 'Used tractor', estimatedValueKobo: 3_000_000 },
        farmer
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('runs the guarantor invite/accept/decline flow with party scoping', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    await expect(service.inviteGuarantor(draft.id, otherFarmer.id, otherFarmer))
      .rejects.toBeInstanceOf(ForbiddenException);
    const invitation = await service.inviteGuarantor(draft.id, otherFarmer.id, farmer);
    expect(invitation.status).toBe('invited');
    // Self-guarantee is nonsense.
    await expect(service.inviteGuarantor(draft.id, farmer.id, farmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
    // Only the invited guarantor may respond.
    await expect(service.acceptGuarantor(invitation.id, farmer)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect((await service.acceptGuarantor(invitation.id, otherFarmer)).status).toBe('accepted');
    // A second response is rejected.
    await expect(service.declineGuarantor(invitation.id, otherFarmer)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('blocks approval while guarantor invitations are pending', async () => {
    const { service } = makeService();
    const draft = await service.apply({ productId: PRODUCT.id, principalKobo: 500_000 }, farmer);
    const invitation = await service.inviteGuarantor(draft.id, otherFarmer.id, farmer);
    await service.submit(draft.id, farmer);
    await service.score(draft.id, lender);
    await expect(service.approve(draft.id, admin)).rejects.toBeInstanceOf(BadRequestException);
    await service.acceptGuarantor(invitation.id, otherFarmer);
    expect((await service.approve(draft.id, admin)).status).toBe('approved');
  });
});
