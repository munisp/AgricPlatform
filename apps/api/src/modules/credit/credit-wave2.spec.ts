import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CreditLoanApplication, CreditLoanProduct, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCreditCollateralRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGroupRepository,
  createInMemoryCreditGuarantorRepository,
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditRestructureRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository,
  InMemoryCreditProductRepository
} from '../../database/repositories/credit-suite.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import {
  CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO,
  CREDIT_MAX_ACTIVE_LOANS,
  CREDIT_REVIEW_CROP_FAILURE,
  CreditService,
  installmentOutstandingKobo
} from './credit.service.js';

/**
 * Wave-2 pack W2-C1: credit-domain design gaps.
 *   V-04 loan restructure · V-05 default cure + settlement-for-less
 *   V-28 guarantor demand lifecycle · V-29 partial payments
 *   V-30 exposure control + top-up consolidation · V-03 crop-failure grace
 */

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };

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

const GROUP_PRODUCT: CreditLoanProduct = {
  id: 'cprd-vsla',
  name: 'VSLA group loan',
  minPrincipalKobo: 100_000,
  maxPrincipalKobo: 10_000_000,
  interestBpsAnnual: 1000,
  termDays: 90,
  groupLending: true,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const transactions = createInMemoryCreditSavingsTransactionRepository();
  const savingsAccounts = createInMemoryCreditSavingsAccountRepository(transactions);
  const loans = createInMemoryCreditLoanRepository();
  const repayments = createInMemoryCreditRepaymentRepository();
  const collateral = createInMemoryCreditCollateralRepository();
  const guarantors = createInMemoryCreditGuarantorRepository();
  const groups = createInMemoryCreditGroupRepository();
  const members = createInMemoryCreditGroupMemberRepository();
  const restructures = createInMemoryCreditRestructureRepository();
  const ledgerAccounts = createInMemoryLedgerAccountRepository();
  const ledgerEntries = createInMemoryLedgerEntryRepository();
  const ledger = new LedgerService(events, ledgerAccounts, ledgerEntries);
  const service = new CreditService(
    events,
    new InMemoryCreditProductRepository([PRODUCT, GROUP_PRODUCT]),
    loans,
    repayments,
    collateral,
    guarantors,
    groups,
    members,
    savingsAccounts,
    new InMemoryProfileRepository(),
    new InMemoryOrderRepository(),
    restructures,
    transactions,
    ledger
  );
  return {
    service,
    events,
    loans,
    repayments,
    guarantors,
    groups,
    members,
    savingsAccounts,
    transactions,
    restructures,
    ledger,
    ledgerEntries
  };
}

/** Seeds an active credit group with the given members (leader first). */
async function seedGroup(
  rig: Rig,
  groupId: string,
  name: string,
  leaderId: string,
  memberIds: string[]
): Promise<void> {
  const now = new Date().toISOString();
  await rig.groups.create({ id: groupId, name, createdBy: leaderId, createdAt: now, status: 'active' });
  await rig.members.add({ groupId, userId: leaderId, role: 'leader', joinedAt: now });
  for (const memberId of memberIds) {
    await rig.members.add({ groupId, userId: memberId, role: 'member', joinedAt: now });
  }
}

type Rig = ReturnType<typeof makeService>;

/** Drives a loan from draft to `repaying` through the reviewer pipeline. */
async function repayingLoan(
  rig: Rig,
  applicant: Pick<User, 'id' | 'roles'> = farmer,
  principalKobo = 1_000_000,
  extra: Partial<{ plotId: string; plantingId: string }> = {}
): Promise<CreditLoanApplication> {
  const draft = await rig.service.apply(
    { productId: PRODUCT.id, principalKobo, purpose: 'Fertiliser', ...extra },
    applicant
  );
  await rig.service.submit(draft.id, applicant);
  await rig.service.score(draft.id, lender);
  await rig.service.approve(draft.id, lender);
  await rig.service.disburse(draft.id, lender);
  return rig.service.startRepayment(draft.id, lender);
}

async function defaultedLoan(rig: Rig): Promise<CreditLoanApplication> {
  const loan = await repayingLoan(rig);
  return rig.service.defaultLoan(loan.id, lender);
}

/* ---------------------------------------------------------- V-29 partials -- */

describe('V-29 partial payments', () => {
  it('two partials sum to the installment; the loan closes only on full coverage', async () => {
    const rig = makeService();
    const loan = await repayingLoan(rig);
    const schedule = await rig.service.getSchedule(loan.id, farmer);
    const first = schedule[0];

    // Partial 1: pays part of the installment — stays pending, loan open.
    const partial = await rig.service.recordPayment(loan.id, 1, farmer, first.amountKobo - 100);
    expect(partial.status).toBe('pending');
    expect(partial.paidAmountKobo).toBe(first.amountKobo - 100);
    expect((await rig.loans.getById(loan.id)).status).toBe('repaying');

    // Partial 2: covers the remainder — installment flips paid.
    const rest = await rig.service.recordPayment(loan.id, 1, farmer, 100);
    expect(rest.status).toBe('paid');
    expect(rest.paidAmountKobo).toBe(first.amountKobo);

    // The loan closes only after EVERY installment is fully covered.
    for (const entry of schedule.slice(1)) {
      await rig.service.recordPayment(loan.id, entry.sequence, farmer);
    }
    expect((await rig.loans.getById(loan.id)).status).toBe('repaid');
  });

  it('rejects overpayment beyond the installment balance (V-57 pattern)', async () => {
    const rig = makeService();
    const loan = await repayingLoan(rig);
    const schedule = await rig.service.getSchedule(loan.id, farmer);
    await expect(
      rig.service.recordPayment(loan.id, 1, farmer, schedule[0].amountKobo + 1)
    ).rejects.toThrowError(/OVERPAYMENT_REJECTED/);
    // After a partial, only the REMAINING balance may be paid.
    await rig.service.recordPayment(loan.id, 1, farmer, 1000);
    await expect(
      rig.service.recordPayment(loan.id, 1, farmer, schedule[0].amountKobo)
    ).rejects.toThrowError(/OVERPAYMENT_REJECTED/);
    // Idempotent replay of a fully paid installment returns stored state.
    await rig.service.recordPayment(loan.id, 1, farmer, schedule[0].amountKobo - 1000);
    const replay = await rig.service.recordPayment(loan.id, 1, farmer);
    expect(replay.status).toBe('paid');
  });

  it('omitting the amount still pays the full remaining balance (back-compat)', async () => {
    const rig = makeService();
    const loan = await repayingLoan(rig);
    const schedule = await rig.service.getSchedule(loan.id, farmer);
    const paid = await rig.service.recordPayment(loan.id, 1, farmer);
    expect(paid.status).toBe('paid');
    expect(paid.paidAmountKobo).toBe(schedule[0].amountKobo);
  });
});

/* ------------------------------------------ V-05 cure + settlement -- */

describe('V-05 default cure and settlement-for-less', () => {
  it('a defaulted loan accepts a cure payment: defaulted → repaying, missed installments re-activate', async () => {
    const rig = makeService();
    const loan = await defaultedLoan(rig);
    expect(loan.status).toBe('defaulted');
    // All open installments are missed while defaulted.
    const missed = await rig.repayments.find({ loanId: loan.id, status: 'missed' });
    expect(missed.length).toBeGreaterThan(0);

    const cured = await rig.service.recordPayment(loan.id, 1, farmer);
    expect(cured.status).toBe('paid');
    const after = await rig.loans.getById(loan.id);
    expect(after.status).toBe('repaying'); // cured
    // Missed installments re-activated (except the one just paid).
    expect(await rig.repayments.find({ loanId: loan.id, status: 'missed' })).toHaveLength(0);
    expect((await rig.repayments.find({ loanId: loan.id, status: 'pending' })).length).toBe(
      missed.length - 1
    );
  });

  it('settlement-for-less posts a BALANCED write-down entry and closes the loan', async () => {
    const rig = makeService();
    const loan = await defaultedLoan(rig);
    const schedule = await rig.repayments.find({ loanId: loan.id });
    const outstanding = schedule.reduce((sum, r) => sum + installmentOutstandingKobo(r), 0);
    const settlementKobo = Math.floor(outstanding / 2);

    const settled = await rig.service.settleDefaultedLoan(loan.id, { settlementKobo }, admin);
    expect(settled.status).toBe('written_off');
    expect(settled.settledAmountKobo).toBe(settlementKobo);
    expect(settled.writeDownKobo).toBe(outstanding - settlementKobo);

    const entry = await rig.ledgerEntries.findByIdempotencyKey(`credit-settlement:${loan.id}`);
    expect(entry).toBeDefined();
    const debits = entry!.postings
      .filter((p) => p.direction === 'debit')
      .reduce((sum, p) => sum + p.amountKobo, 0);
    const credits = entry!.postings
      .filter((p) => p.direction === 'credit')
      .reduce((sum, p) => sum + p.amountKobo, 0);
    expect(debits).toBe(outstanding); // cash + loan_losses
    expect(credits).toBe(outstanding); // receivable written down
    expect(debits).toBe(credits);

    // Idempotent replay: no second entry, no state change.
    const replay = await rig.service.settleDefaultedLoan(loan.id, { settlementKobo }, admin);
    expect(replay.status).toBe('written_off');
    expect(
      (await rig.ledgerEntries.find({})).filter((e) =>
        e.idempotencyKey.startsWith('credit-settlement:')
      )
    ).toHaveLength(1);
  });

  it('rejects a settlement covering the full balance (that is the cure path)', async () => {
    const rig = makeService();
    const loan = await defaultedLoan(rig);
    const schedule = await rig.repayments.find({ loanId: loan.id });
    const outstanding = schedule.reduce((sum, r) => sum + installmentOutstandingKobo(r), 0);
    await expect(
      rig.service.settleDefaultedLoan(loan.id, { settlementKobo: outstanding }, admin)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      rig.service.settleDefaultedLoan(loan.id, { settlementKobo: outstanding + 1 }, admin)
    ).rejects.toThrowError(/OVERPAYMENT_REJECTED/);
  });

  it('settlement is refused on non-defaulted loans', async () => {
    const rig = makeService();
    const loan = await repayingLoan(rig);
    await expect(
      rig.service.settleDefaultedLoan(loan.id, { settlementKobo: 1 }, admin)
    ).rejects.toThrowError(/SETTLEMENT_STATE/);
  });
});

/* ---------------------------------------------------------- V-04 restructure -- */

describe('V-04 loan restructure', () => {
  it('regenerates the schedule over the outstanding balance; the old schedule is superseded and pinned', async () => {
    const rig = makeService();
    const loan = await repayingLoan(rig);
    const original = await rig.service.getSchedule(loan.id, farmer);
    // Pay installment 1 fully + a partial on 2 so the outstanding is not the face value.
    await rig.service.recordPayment(loan.id, 1, farmer);
    const second = original[1];
    await rig.service.recordPayment(loan.id, 2, farmer, 1000);
    const outstanding =
      original
        .slice(1)
        .reduce((sum, r) => sum + r.amountKobo, 0) - 1000;

    const { loan: after, restructure } = await rig.service.restructureLoan(
      loan.id,
      { termDays: 90, reason: 'Flood damage — grace extension' },
      lender
    );
    expect(after.status).toBe('repaying');
    expect(restructure.version).toBe(1);
    expect(restructure.outstandingKobo).toBe(outstanding);
    expect(restructure.supersededSchedule).toHaveLength(original.length - 1); // all but the paid one
    expect(restructure.scoreAfter).toBeGreaterThan(0); // factor recompute hook pinned

    const rows = await rig.repayments.find({ loanId: loan.id });
    const superseded = rows.filter((r) => r.status === 'superseded');
    const open = rows.filter((r) => r.status === 'pending');
    const paid = rows.filter((r) => r.status === 'paid');
    expect(superseded).toHaveLength(original.length - 1);
    expect(paid).toHaveLength(1); // installment 1 untouched
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((r) => r.scheduleVersion === 2)).toBe(true);
    // New schedule totals outstanding + restructure interest (12% p.a., 90d).
    const newTotal = open.reduce((sum, r) => sum + r.amountKobo, 0);
    const interest = Math.floor((outstanding * 1200 * 90) / (10_000 * 365));
    expect(newTotal).toBe(outstanding + interest);

    // A sequence that exists ONLY as a superseded row (the 90d replacement
    // has 3 installments; the original had 6) refuses payment.
    await expect(
      rig.service.recordPayment(loan.id, 6, farmer, 1)
    ).rejects.toThrowError(/superseded/);
    // A shared sequence targets the OPEN row of the current schedule.
    const paidNew = await rig.service.recordPayment(loan.id, 2, farmer, 500);
    expect(paidNew.scheduleVersion).toBe(2);
    expect(paidNew.paidAmountKobo).toBe(500);
    // The superseded row for that sequence is untouched (immutable history).
    const supersededSecond = (await rig.repayments.find({ loanId: loan.id })).find(
      (r) => r.sequence === 2 && r.status === 'superseded'
    )!;
    expect(supersededSecond.paidAmountKobo).toBe(1000); // the pre-restructure partial
    void second;
  });

  it('concurrent restructures: the CAS loser gets a 409 and never touches the schedule', async () => {
    const rig = makeService();
    const loan = await repayingLoan(rig);
    const before = await rig.repayments.find({ loanId: loan.id });

    const [a, b] = await Promise.allSettled([
      rig.service.restructureLoan(loan.id, { termDays: 90, reason: 'race A' }, lender),
      rig.service.restructureLoan(loan.id, { termDays: 60, reason: 'race B' }, admin)
    ]);
    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    // Exactly ONE restructure record and ONE replacement schedule exist.
    expect(await rig.restructures.find({ loanId: loan.id })).toHaveLength(1);
    const after = await rig.repayments.find({ loanId: loan.id });
    expect(after.filter((r) => r.status === 'superseded')).toHaveLength(
      before.filter((r) => r.status === 'pending').length
    );
    expect(after.filter((r) => r.status === 'pending').every((r) => r.scheduleVersion === 2)).toBe(
      true
    );
  });

  it('refuses to restructure a loan that is not repaying', async () => {
    const rig = makeService();
    const loan = await defaultedLoan(rig);
    await expect(
      rig.service.restructureLoan(loan.id, { termDays: 90, reason: 'no' }, lender)
    ).rejects.toThrowError(/RESTRUCTURE_STATE/);
  });
});

/* ------------------------------------------- V-28 guarantor demands -- */

describe('V-28 guarantor demand lifecycle', () => {
  const guarantorA: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['farmer'] };

  it('group-loan default issues demands to the accepted co-obligors; acceptance posts the liability leg', async () => {
    const rig = makeService();
    const groupId = 'cgrp-kano';
    await seedGroup(rig, groupId, 'Kano VSLA', farmer.id, [guarantorA.id]);

    const draft = await rig.service.applyForGroup(
      { productId: GROUP_PRODUCT.id, groupId, principalKobo: 900_000, purpose: 'Inputs' },
      farmer
    );
    await rig.service.submit(draft.id, farmer);
    await rig.service.score(draft.id, lender);
    await rig.service.approve(draft.id, lender);
    await rig.service.disburse(draft.id, lender);
    const loan = await rig.service.startRepayment(draft.id, lender);
    // The co-obligor was recorded as an accepted guarantor at application.
    const accepted = await rig.guarantors.find({ loanId: loan.id, status: 'accepted' });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].guarantorUserId).toBe(guarantorA.id);

    const schedule = await rig.repayments.find({ loanId: loan.id });
    const outstanding = schedule.reduce((sum, r) => sum + installmentOutstandingKobo(r), 0);

    await rig.service.defaultLoan(loan.id, lender);

    // Demand issued for the full outstanding balance (single guarantor).
    const called = await rig.guarantors.find({ loanId: loan.id, status: 'called' });
    expect(called).toHaveLength(1);
    expect(called[0].demandAmountKobo).toBe(outstanding);
    const demandEvent = (await rig.events.listOutbox()).find(
      (e) => e.name === 'credit.guarantor.demand_issued'
    );
    expect(demandEvent?.payload).toMatchObject({
      guarantorUserId: guarantorA.id,
      demandAmountKobo: outstanding
    });

    // Reject non-guarantor acceptance.
    await expect(
      rig.service.acceptGuarantorDemand(called[0].id, farmer)
    ).rejects.toThrowError(/Only the called guarantor/);

    // Acceptance posts the liability leg (debit guarantor receivable /
    // credit borrower receivable), idempotent by entity-derived key.
    const liable = await rig.service.acceptGuarantorDemand(called[0].id, guarantorA);
    expect(liable.status).toBe('liable');
    const leg = await rig.ledgerEntries.findByIdempotencyKey(
      `credit-guarantor-liability:${called[0].id}`
    );
    expect(leg).toBeDefined();
    const debits = leg!.postings.filter((p) => p.direction === 'debit');
    const credits = leg!.postings.filter((p) => p.direction === 'credit');
    expect(debits).toEqual([
      expect.objectContaining({
        accountCode: `member:${guarantorA.id}:guarantee_receivable`,
        amountKobo: outstanding
      })
    ]);
    expect(credits).toEqual([
      expect.objectContaining({
        accountCode: `member:${farmer.id}:loans_receivable`,
        amountKobo: outstanding
      })
    ]);
    const replay = await rig.service.acceptGuarantorDemand(called[0].id, guarantorA);
    expect(replay.status).toBe('liable'); // idempotent, no second leg
    expect(
      (await rig.ledgerEntries.find({})).filter((e) =>
        e.idempotencyKey.startsWith('credit-guarantor-liability:')
      )
    ).toHaveLength(1);
  });

  it('settlement without consent never touches savings; with recorded consent it debits savings', async () => {
    const rig = makeService();
    const groupId = 'cgrp-jos';
    await seedGroup(rig, groupId, 'Jos VSLA', farmer.id, [guarantorA.id]);
    const draft = await rig.service.applyForGroup(
      { productId: GROUP_PRODUCT.id, groupId, principalKobo: 600_000, purpose: 'Seed' },
      farmer
    );
    await rig.service.submit(draft.id, farmer);
    await rig.service.score(draft.id, lender);
    await rig.service.approve(draft.id, lender);
    await rig.service.disburse(draft.id, lender);
    const loan = await rig.service.startRepayment(draft.id, lender);
    await rig.service.defaultLoan(loan.id, lender);
    const demand = (await rig.guarantors.find({ loanId: loan.id, status: 'called' }))[0];
    await rig.service.acceptGuarantorDemand(demand.id, guarantorA);

    // Settlement WITHOUT consentRef: cash leg posts, savings untouched.
    const settledCash = await rig.service.settleGuarantorDemand(demand.id, guarantorA);
    expect(settledCash.status).toBe('settled');
    expect(settledCash.consentRef).toBeUndefined();
    expect(await rig.savingsAccounts.findOne({ userId: guarantorA.id })).toBeUndefined();

    // Second demand flow with consent: fund the guarantor's savings, then settle.
    const rig2 = makeService();
    const groupId2 = 'cgrp-sokoto';
    await seedGroup(rig2, groupId2, 'Sokoto VSLA', farmer.id, [guarantorA.id]);
    const draft2 = await rig2.service.applyForGroup(
      { productId: GROUP_PRODUCT.id, groupId: groupId2, principalKobo: 600_000, purpose: 'Seed' },
      farmer
    );
    await rig2.service.submit(draft2.id, farmer);
    await rig2.service.score(draft2.id, lender);
    await rig2.service.approve(draft2.id, lender);
    await rig2.service.disburse(draft2.id, lender);
    const loan2 = await rig2.service.startRepayment(draft2.id, lender);
    await rig2.service.defaultLoan(loan2.id, lender);
    const demand2 = (await rig2.guarantors.find({ loanId: loan2.id, status: 'called' }))[0];
    await rig2.service.acceptGuarantorDemand(demand2.id, guarantorA);

    // Consent without funds → refused before any ledger posting.
    const now = new Date().toISOString();
    await rig2.savingsAccounts.create({
      id: 'csav-aisha',
      userId: guarantorA.id,
      balanceKobo: 10,
      updatedAt: now
    });
    await expect(
      rig2.service.settleGuarantorDemand(demand2.id, guarantorA, { consentRef: 'consent-001' })
    ).rejects.toThrowError(/cannot cover/);
    expect(
      await rig2.ledgerEntries.findByIdempotencyKey(`credit-guarantor-settlement:${demand2.id}`)
    ).toBeUndefined();

    // Fund the account and settle with consent: savings debited by exactly the demand.
    const funded = await rig2.savingsAccounts.getById('csav-aisha');
    await rig2.savingsAccounts.applyTransaction(
      'csav-aisha',
      { balanceKobo: funded.balanceKobo },
      { balanceKobo: funded.balanceKobo + 10_000_000, updatedAt: new Date().toISOString() },
      {
        id: 'ctxn-seed',
        accountId: 'csav-aisha',
        direction: 'deposit',
        amountKobo: 10_000_000,
        balanceAfterKobo: funded.balanceKobo + 10_000_000,
        ref: 'seed-deposit',
        createdAt: new Date().toISOString()
      }
    );
    const settled = await rig2.service.settleGuarantorDemand(demand2.id, guarantorA, {
      consentRef: 'consent-001'
    });
    expect(settled.status).toBe('settled');
    expect(settled.consentRef).toBe('consent-001');
    const after = await rig2.savingsAccounts.getById('csav-aisha');
    expect(after.balanceKobo).toBe(10_000_010 - (demand2.demandAmountKobo ?? 0));
    const leg = await rig2.ledgerEntries.findByIdempotencyKey(
      `credit-guarantor-settlement:${demand2.id}`
    );
    expect(leg).toBeDefined();
  });
});

/* --------------------------------- V-30 exposure control + top-up -- */

describe('V-30 exposure control', () => {
  it('rejects the application once the active-loan cap is reached', async () => {
    const rig = makeService();
    // Farmer holds CREDIT_MAX_ACTIVE_LOANS active loans.
    for (let i = 0; i < CREDIT_MAX_ACTIVE_LOANS; i += 1) {
      await repayingLoan(rig, farmer, 100_000);
    }
    await expect(
      rig.service.apply({ productId: PRODUCT.id, principalKobo: 100_000 }, farmer)
    ).rejects.toThrowError(/EXPOSURE_CAP/);
    // Another borrower is unaffected.
    const other: Pick<User, 'id' | 'roles'> = { id: 'user-zainab', roles: ['farmer'] };
    const draft = await rig.service.apply({ productId: PRODUCT.id, principalKobo: 100_000 }, other);
    expect(draft.status).toBe('draft');
  });

  it('rejects the application when the aggregate exposure ceiling would be exceeded', async () => {
    const rig = makeService();
    // Seed one repaying loan whose outstanding balance nearly fills the ceiling.
    const seededLoan: CreditLoanApplication = {
      id: 'cloan-big',
      applicantUserId: farmer.id,
      productId: PRODUCT.id,
      principalKobo: CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO - 500_000,
      status: 'repaying',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await rig.loans.create(seededLoan);
    await rig.repayments.create({
      id: 'crp-big-1',
      loanId: seededLoan.id,
      sequence: 1,
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      amountKobo: CREDIT_MAX_AGGREGATE_EXPOSURE_KOBO - 500_000,
      paidAmountKobo: 0,
      scheduleVersion: 1,
      status: 'pending'
    });
    // Ceiling: outstanding + new principal > ceiling → 400.
    await expect(
      rig.service.apply({ productId: PRODUCT.id, principalKobo: 500_001 }, farmer)
    ).rejects.toThrowError(/EXPOSURE_CEILING/);
    // A tiny application that stays under the ceiling is fine.
    const draft = await rig.service.apply({ productId: PRODUCT.id, principalKobo: 100_000 }, farmer);
    expect(draft.status).toBe('draft');
  });

  it('top-up consolidates the repaying loan atomically at approval', async () => {
    const rig = makeService();
    const old = await repayingLoan(rig, farmer, 900_000);
    const oldSchedule = await rig.service.getSchedule(old.id, farmer);
    // Pay installment 1 fully, partial 500 on #2.
    await rig.service.recordPayment(old.id, 1, farmer);
    await rig.service.recordPayment(old.id, 2, farmer, 500);
    const outstanding =
      oldSchedule.slice(1).reduce((sum, r) => sum + r.amountKobo, 0) - 500;

    const topUp = await rig.service.applyForTopUp(
      { productId: PRODUCT.id, principalKobo: 200_000, consolidatesLoanId: old.id },
      farmer
    );
    expect(topUp.consolidatesLoanId).toBe(old.id);
    // Duplicate consolidation of the same loan is rejected.
    await expect(
      rig.service.applyForTopUp(
        { productId: PRODUCT.id, principalKobo: 100_000, consolidatesLoanId: old.id },
        farmer
      )
    ).rejects.toThrowError(ConflictException);

    await rig.service.submit(topUp.id, farmer);
    await rig.service.score(topUp.id, lender);
    await rig.service.approve(topUp.id, lender);

    const oldAfter = await rig.loans.getById(old.id);
    expect(oldAfter.status).toBe('consolidated');
    const oldRows = await rig.repayments.find({ loanId: old.id });
    expect(oldRows.filter((r) => r.status === 'paid')).toHaveLength(1);
    expect(oldRows.filter((r) => r.status === 'superseded')).toHaveLength(
      oldSchedule.length - 1
    );

    // New loan's schedule covers top-up principal + folded outstanding + interest.
    const newRows = await rig.repayments.find({ loanId: topUp.id });
    expect(newRows.length).toBeGreaterThan(0);
    const newTotal = newRows.reduce((sum, r) => sum + r.amountKobo, 0);
    const interest = Math.floor(((200_000 + outstanding) * 1200 * 180) / (10_000 * 365));
    expect(newTotal).toBe(200_000 + outstanding + interest);

    // The consolidated loan refuses payments; the fold is pinned as a restructure record.
    await expect(rig.service.recordPayment(old.id, 2, farmer)).rejects.toThrowError(
      BadRequestException
    );
    const folds = await rig.restructures.find({ loanId: old.id });
    expect(folds).toHaveLength(1);
    expect(folds[0].outstandingKobo).toBe(outstanding);

    // Approval replay is idempotent (no duplicate schedule, no re-fold).
    await rig.service.approve(topUp.id, lender);
    expect((await rig.repayments.find({ loanId: topUp.id })).length).toBe(newRows.length);
    expect(await rig.restructures.find({ loanId: old.id })).toHaveLength(1);
  });

  it('top-up refuses to consolidate another borrower’s loan', async () => {
    const rig = makeService();
    const old = await repayingLoan(rig, farmer, 900_000);
    const other: Pick<User, 'id' | 'roles'> = { id: 'user-zainab', roles: ['farmer'] };
    await expect(
      rig.service.applyForTopUp(
        { productId: PRODUCT.id, principalKobo: 100_000, consolidatesLoanId: old.id },
        other
      )
    ).rejects.toThrowError(/own loans/);
  });
});

/* ------------------------------------- V-03 crop-failure grace (integration) -- */

describe('V-03 planting-failure subscriber (integration)', () => {
  it('farms.planting.failed suspends aging and flags the linked loan for review; restructure resolves the flag', async () => {
    const rig = makeService();
    rig.service.onModuleInit();
    const loan = await repayingLoan(rig, farmer, 1_000_000, {
      plotId: 'plot-42',
      plantingId: 'plant-42'
    });

    await rig.events.publish(
      'farms.planting.status_changed',
      {
        plantingId: 'plant-42',
        plotId: 'plot-42',
        farmerId: farmer.id,
        cropType: 'maize',
        failureReason: 'drought',
        to: 'failed',
        occurredAt: new Date().toISOString()
      },
      'system'
    );
    // The subscriber runs fire-and-forget; flush the micro/macro-task queues.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const flagged = await rig.loans.getById(loan.id);
    expect(flagged.reviewFlag).toBe(CREDIT_REVIEW_CROP_FAILURE);
    expect(flagged.agingSuspendedAt).toBeDefined();

    // Aging suspended: an overdue pending installment does NOT read 'late'.
    const first = (await rig.repayments.find({ loanId: loan.id })).find((r) => r.sequence === 1)!;
    await rig.repayments.update(first.id, {
      dueAt: new Date(Date.now() - 10 * 86_400_000).toISOString()
    });
    const schedule = await rig.service.getSchedule(loan.id, farmer);
    expect(schedule.find((r) => r.sequence === 1)!.status).toBe('pending'); // not 'late'

    const flagEvent = (await rig.events.listOutbox()).find(
      (e) => e.name === 'credit.loan.flagged_for_review'
    );
    expect(flagEvent?.payload).toMatchObject({
      loanId: loan.id,
      reviewFlag: CREDIT_REVIEW_CROP_FAILURE,
      plantingId: 'plant-42',
      failureReason: 'drought'
    });

    // Replay of the failure event is idempotent (still one flag event).
    await rig.events.publish(
      'farms.planting.status_changed',
      {
        plantingId: 'plant-42',
        plotId: 'plot-42',
        farmerId: farmer.id,
        cropType: 'maize',
        failureReason: 'drought',
        to: 'failed',
        occurredAt: new Date().toISOString()
      },
      'system'
    );
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(
      (await rig.events.listOutbox()).filter((e) => e.name === 'credit.loan.flagged_for_review')
    ).toHaveLength(1);

    // The restructure (V-04) resolves the review: flag cleared, aging resumes.
    await rig.service.restructureLoan(
      loan.id,
      { termDays: 120, reason: 'Drought grace restructure' },
      lender
    );
    const resolved = await rig.loans.getById(loan.id);
    expect(resolved.reviewFlag).toBeUndefined();
    expect(resolved.agingSuspendedAt).toBeUndefined();
  });

  it('ignores failures that match no linked loan', async () => {
    const rig = makeService();
    rig.service.onModuleInit();
    await repayingLoan(rig); // no plot/planting link
    await rig.events.publish(
      'farms.planting.status_changed',
      { plantingId: 'plant-99', plotId: 'plot-99', farmerId: farmer.id, cropType: 'rice', failureReason: 'flood', to: 'failed',
        occurredAt: new Date().toISOString() },
      'system'
    );
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(
      (await rig.events.listOutbox()).filter((e) => e.name === 'credit.loan.flagged_for_review')
    ).toHaveLength(0);
  });
});
