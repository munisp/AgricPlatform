import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryLedgerAccountRepository } from '../../database/repositories/ledger.repository.js';
import { createInMemoryLedgerEntryRepository } from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryCarbonEstimateRepository,
  createInMemoryCarbonEvidenceRepository,
  createInMemoryCarbonPlotRepository,
  createInMemoryVslaContributionRepository,
  createInMemoryVslaCycleRepository,
  createInMemoryVslaGroupRepository,
  createInMemoryVslaLoanRepository,
  createInMemoryVslaLoanRepaymentRepository,
  createInMemoryVslaMeetingRepository,
  createInMemoryVslaCashCountRepository,
  createInMemoryVslaMemberRepository,
  createInMemoryVslaShareOutPlanRepository,
  createInMemoryVslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { ProviderRequestError } from '../integrations/drivers/http.js';
import { InMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from '../users/users.service.js';
import { CO2E_COEFFICIENT_VERSION } from './carbon-coefficients.js';
import type { NdviProvider } from './ndvi.provider.js';
import {
  ESTIMATE_DISCLAIMER,
  groupBadDebtAccountCode,
  groupCashAccountCode,
  groupCashShortageAccountCode,
  groupInterestIncomeAccountCode,
  groupLoansReceivableAccountCode,
  memberSavingsAccountCode,
  VslaCarbonService
} from './vsla-carbon.service.js';

const lead = { id: 'user-lead', roles: ['chapter_lead'] } as unknown as User;
const farmer = { id: 'user-farmer', roles: ['farmer'] } as unknown as User;
const farmer2 = { id: 'user-farmer-2', roles: ['farmer'] } as unknown as User;
const enumerator = { id: 'user-enum', roles: ['enumerator'] } as unknown as User;
const donor = { id: 'user-donor', roles: ['donor'] } as unknown as User;
const admin = { id: 'user-admin', roles: ['admin'] } as unknown as User;

/**
 * OB-14: leadership grants consult the user directory — the fixture actors
 * exist here as OTP-VERIFIED accounts (leadership eligible).
 */
function fixtureDirectory(): UsersService {
  const actors = [lead, farmer, farmer2, enumerator, donor, admin];
  const verified = (actor: User, index: number): User => ({
    ...actor,
    phone: `+2348000000${String(index + 10)}`,
    fullName: actor.id,
    preferredLanguage: 'en',
    kycTier: 'tier_0',
    isVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  return new UsersService(new InMemoryUserRepository(actors.map(verified)));
}

const stubNdvi: NdviProvider = {
  name: 'stub',
  assess: () =>
    Promise.resolve({
      plotId: 'plot',
      season: '2026-wet',
      healthScore: 64,
      classification: 'normal',
      basis: 'stub'
    }),
  status: () => Promise.resolve({ configured: true, healthy: true, detail: 'stub' })
};

/** Chapter stub: only 'chapter-1' exists (chapters model link validation). */
const chaptersStub = {
  getById: (id: string) =>
    id === 'chapter-1'
      ? Promise.resolve({ id, name: 'Kano Chapter' })
      : Promise.reject(new NotFoundException(`Chapter '${id}' not found`))
};

function makeService(ndvi: NdviProvider = stubNdvi) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const shareOuts = createInMemoryVslaShareOutRepository();
  const shareOutPlan = createInMemoryVslaShareOutPlanRepository();
  const loans = createInMemoryVslaLoanRepository();
  const repayments = createInMemoryVslaLoanRepaymentRepository();
  const service = new VslaCarbonService(
    createInMemoryVslaGroupRepository(),
    createInMemoryVslaMemberRepository(),
    createInMemoryVslaCycleRepository(),
    createInMemoryVslaContributionRepository(),
    shareOuts,
    shareOutPlan,
    loans,
    repayments,
    createInMemoryCarbonPlotRepository(),
    createInMemoryCarbonEvidenceRepository(),
    createInMemoryCarbonEstimateRepository(),
    ledger,
    new H3Service(),
    events,
    ndvi,
    chaptersStub as never,
    createInMemoryVslaMeetingRepository(),
    createInMemoryVslaCashCountRepository(),
    fixtureDirectory()
  );
  return { service, ledger, events, shareOuts, shareOutPlan, loans, repayments };
}

/** Group with two members and an open cycle — the standard fixture. */
async function makeGroupWithCycle(service: VslaCarbonService) {
  const group = await service.createGroup(lead, { name: 'Kano Women Savings' });
  const member2 = await service.addMember(lead, group.id, { userId: farmer.id });
  const leadMember = (await service.listMembers(admin, group.id)).find((m) => m.userId === lead.id);
  const cycle = await service.openCycle(lead, group.id, '2026 Cycle 1');
  return { group, cycle, leadMember: leadMember!, member2 };
}

async function contributeBoth(
  service: VslaCarbonService,
  cycleId: string,
  leadMemberId: string,
  member2Id: string,
  amounts: [number, number] = [100_000, 300_000]
) {
  await service.contribute(lead, cycleId, {
    memberId: leadMemberId,
    amountKobo: amounts[0],
    idempotencyKey: 'c-lead'
  });
  await service.contribute(farmer, cycleId, {
    memberId: member2Id,
    amountKobo: amounts[1],
    idempotencyKey: 'c-farmer'
  });
}

describe('VSLA group registry + RBAC', () => {
  it('creates a group with ledger sub-accounts and a lead membership', async () => {
    const { service, ledger } = makeService();
    const group = await service.createGroup(lead, { name: 'Zaria Cooperative VSLA' });
    expect(group.status).toBe('ACTIVE');
    expect(group.leadUserId).toBe(lead.id);
    await expect(ledger.getAccountByCode(groupCashAccountCode(group.id))).resolves.toMatchObject({
      type: 'asset'
    });
    await expect(
      ledger.getAccountByCode(groupLoansReceivableAccountCode(group.id))
    ).resolves.toMatchObject({ type: 'asset' });
    await expect(
      ledger.getAccountByCode(groupInterestIncomeAccountCode(group.id))
    ).resolves.toMatchObject({ type: 'revenue' });
    const members = await service.listMembers(admin, group.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: lead.id, role: 'lead' });
  });

  it('rejects group creation by non-admin roles (RBAC)', async () => {
    const { service } = makeService();
    await expect(service.createGroup(farmer, { name: 'Nope' })).rejects.toThrow(ForbiddenException);
  });

  it('links groups to an existing chapter and rejects unknown chapters (fail-closed)', async () => {
    const { service } = makeService();
    const linked = await service.createGroup(lead, { name: 'Linked', chapterId: 'chapter-1' });
    expect(linked.chapterId).toBe('chapter-1');
    await expect(
      service.createGroup(lead, { name: 'Broken', chapterId: 'chapter-missing' })
    ).rejects.toThrow(NotFoundException);
  });

  it('scopes the group list for farmers to their own memberships', async () => {
    const { service } = makeService();
    const own = await service.createGroup(lead, { name: 'Own' });
    await service.addMember(lead, own.id, { userId: farmer.id });
    await service.createGroup(admin, { name: 'Other' });
    const farmerGroups = await service.listGroups(farmer);
    expect(farmerGroups.map((g) => g.id)).toEqual([own.id]);
    const donorGroups = await service.listGroups(donor);
    expect(donorGroups).toHaveLength(2);
  });

  it('adds members idempotently (re-join replays, no duplicate rows)', async () => {
    const { service } = makeService();
    const group = await service.createGroup(lead, { name: 'G' });
    const first = await service.addMember(lead, group.id, { userId: farmer.id });
    const second = await service.addMember(lead, group.id, { userId: farmer.id });
    expect(second.id).toBe(first.id);
    expect(await service.listMembers(admin, group.id)).toHaveLength(2);
  });
});

describe('savings cycles + ledger-backed contributions', () => {
  it('allows at most one OPEN cycle per group', async () => {
    const { service } = makeService();
    const group = await service.createGroup(lead, { name: 'G' });
    await service.openCycle(lead, group.id, 'C1');
    await expect(service.openCycle(lead, group.id, 'C2')).rejects.toThrow(ConflictException);
  });

  it('posts double-entry contributions (pool cash up, member liability up)', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, member2 } = await makeGroupWithCycle(service);
    const contribution = await service.contribute(farmer, cycle.id, {
      memberId: member2.id,
      amountKobo: 50_000,
      idempotencyKey: 'k1'
    });
    const entry = await ledger.getEntry(contribution.ledgerEntryId);
    const debits = entry.postings
      .filter((p) => p.direction === 'debit')
      .reduce((sum, p) => sum + p.amountKobo, 0);
    const credits = entry.postings
      .filter((p) => p.direction === 'credit')
      .reduce((sum, p) => sum + p.amountKobo, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(50_000);
    const cash = await ledger.balance(groupCashAccountCode(group.id));
    expect(cash.balanceKobo).toBe(50_000);
    const liability = await ledger.balance(memberSavingsAccountCode(group.id, farmer.id));
    expect(liability.creditsKobo).toBe(50_000);
  });

  it('replays contributions idempotently (same key → same record, ledger conserved)', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, member2 } = await makeGroupWithCycle(service);
    const first = await service.contribute(farmer, cycle.id, {
      memberId: member2.id,
      amountKobo: 50_000,
      idempotencyKey: 'dup'
    });
    const replay = await service.contribute(farmer, cycle.id, {
      memberId: member2.id,
      amountKobo: 50_000,
      idempotencyKey: 'dup'
    });
    expect(replay.id).toBe(first.id);
    expect(await service.listContributions(admin, cycle.id)).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(50_000);
  });

  it('rejects contributions into a CLOSED cycle', async () => {
    const { service } = makeService();
    const { cycle, member2 } = await makeGroupWithCycle(service);
    await service.closeCycle(lead, cycle.id);
    await expect(
      service.contribute(farmer, cycle.id, {
        memberId: member2.id,
        amountKobo: 1_000,
        idempotencyKey: 'late'
      })
    ).rejects.toThrow(ConflictException);
  });

  it('rejects contributions for unknown members and by non-owner members', async () => {
    const { service } = makeService();
    const { cycle, member2 } = await makeGroupWithCycle(service);
    await expect(
      service.contribute(farmer, cycle.id, {
        memberId: 'member-missing',
        amountKobo: 1_000,
        idempotencyKey: 'x1'
      })
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.contribute(farmer2, cycle.id, {
        memberId: member2.id,
        amountKobo: 1_000,
        idempotencyKey: 'x2'
      })
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.contribute(enumerator, cycle.id, {
        memberId: member2.id,
        amountKobo: -5,
        idempotencyKey: 'x3'
      })
    ).rejects.toThrow(BadRequestException);
  });
});

describe('internal loans with simple interest', () => {
  it('issues a loan with a balanced interest posting (receivable = total due)', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, (await service.listMembers(admin, group.id)).find((m) => m.userId === lead.id)!.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 1_000,
      idempotencyKey: 'issue-key-1'
    });
    expect(loan.totalDueKobo).toBe(110_000);
    const entry = await ledger.getEntry(loan.ledgerEntryId);
    const debits = entry.postings
      .filter((p) => p.direction === 'debit')
      .reduce((sum, p) => sum + p.amountKobo, 0);
    const credits = entry.postings
      .filter((p) => p.direction === 'credit')
      .reduce((sum, p) => sum + p.amountKobo, 0);
    expect(debits).toBe(credits);
    expect((await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo).toBe(
      110_000
    );
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(300_000);
  });

  it('never lets the pool lend cash it does not hold (never-negative invariant)', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id, [10_000, 10_000]);
    await expect(
      service.issueLoan(lead, group.id, {
        memberId: member2.id,
        principalKobo: 100_000,
        interestRateBps: 500,
        idempotencyKey: 'issue-key-2'
      })
    ).rejects.toThrow(BadRequestException);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(20_000);
    expect((await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo).toBe(0);
  });

  it('requires an open cycle to issue loans', async () => {
    const { service } = makeService();
    const group = await service.createGroup(lead, { name: 'G' });
    const member = await service.addMember(lead, group.id, { userId: farmer.id });
    await expect(
      service.issueLoan(lead, group.id, {
        memberId: member.id,
        principalKobo: 10_000,
        interestRateBps: 0,
        idempotencyKey: 'issue-key-3'
      })
    ).rejects.toThrow(ConflictException);
  });

  it('tracks repayments to full repayment (ACTIVE → REPAID)', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 1_000,
      idempotencyKey: 'issue-key-4'
    });
    const first = await service.repayLoan(farmer, loan.id, {
      amountKobo: 50_000,
      idempotencyKey: 'r1'
    });
    expect(first.loan.repaidKobo).toBe(50_000);
    expect(first.loan.status).toBe('ACTIVE');
    // V-57: overpay is REJECTED (400), never silently clamped — and nothing moves.
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 999_999, idempotencyKey: 'r2' })
    ).rejects.toThrow(BadRequestException);
    expect((await service.getLoan(loan.id)).repaidKobo).toBe(50_000);
    const second = await service.repayLoan(farmer, loan.id, {
      amountKobo: 60_000, // exact outstanding
      idempotencyKey: 'r2'
    });
    expect(second.repayment.amountKobo).toBe(60_000);
    expect(second.loan.status).toBe('REPAID');
    expect(second.loan.repaidKobo).toBe(110_000);
    expect((await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo).toBe(0);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(410_000);
  });

  it('replays repayments idempotently and rejects repayments on settled loans', async () => {
    const { service } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 10_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-key-5'
    });
    const first = await service.repayLoan(farmer, loan.id, {
      amountKobo: 10_000,
      idempotencyKey: 'rr'
    });
    const replay = await service.repayLoan(farmer, loan.id, {
      amountKobo: 10_000,
      idempotencyKey: 'rr'
    });
    expect(replay.repayment.id).toBe(first.repayment.id);
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(1);
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 1, idempotencyKey: 'rr2' })
    ).rejects.toThrow(ConflictException);
  });

  it('only the borrower or a group admin may record repayments', async () => {
    const { service } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 10_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-key-6'
    });
    await expect(
      service.repayLoan(farmer2, loan.id, { amountKobo: 1_000, idempotencyKey: 'z1' })
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('stage-24 audit regression: concurrent repayments converge (A1-4 / A4-5)', () => {
  async function makeRepayableLoan() {
    const ctx = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(ctx.service);
    await contributeBoth(ctx.service, cycle.id, leadMember.id, member2.id);
    const loan = await ctx.service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-key-7'
    });
    return { ...ctx, group, loan };
  }

  it('two concurrent repayments BOTH commit — loan, repayment rows and ledger agree', async () => {
    const { service, ledger, group, loan } = await makeRepayableLoan();
    // Two legitimate repayments race (double-click across two channels).
    const [a, b] = await Promise.allSettled([
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-1' }),
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-2' })
    ]);
    // Claim-first: both claims fit under total_due_kobo, so neither 409s.
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const final = await service.getLoan(loan.id);
    const repayments = await service.listRepayments(admin, loan.id);
    const receivable = await ledger.balance(groupLoansReceivableAccountCode(group.id));
    expect(repayments).toHaveLength(2);
    expect(repayments.reduce((sum, row) => sum + row.amountKobo, 0)).toBe(80_000);
    expect(final.repaidKobo).toBe(80_000); // loan credited for BOTH payments
    expect(receivable.balanceKobo).toBe(20_000); // 100k - 80k: ledger agrees with the loan row
  });

  it('a racer that would overshoot total_due 409s BEFORE any money moves', async () => {
    const { service, ledger, group, loan } = await makeRepayableLoan();
    const [a, b] = await Promise.allSettled([
      service.repayLoan(farmer, loan.id, { amountKobo: 60_000, idempotencyKey: 'repay-a' }),
      service.repayLoan(farmer, loan.id, { amountKobo: 60_000, idempotencyKey: 'repay-b' })
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const loser = a.status === 'rejected' ? a : (b as PromiseRejectedResult);
    expect(loser.reason).toBeInstanceOf(ConflictException);
    const final = await service.getLoan(loan.id);
    const repayments = await service.listRepayments(admin, loan.id);
    const receivable = await ledger.balance(groupLoansReceivableAccountCode(group.id));
    // Exactly ONE payment committed anywhere — the loser's kobo never reached
    // the ledger, so nothing is trapped against the receivable guard.
    expect(repayments).toHaveLength(1);
    expect(final.repaidKobo).toBe(60_000);
    expect(receivable.balanceKobo).toBe(40_000);
    // The loan still accepts the remaining 40k (no trapped overpayment).
    const topUp = await service.repayLoan(farmer, loan.id, {
      amountKobo: 40_000,
      idempotencyKey: 'repay-c'
    });
    expect(topUp.loan.status).toBe('REPAID');
    expect(topUp.loan.repaidKobo).toBe(100_000);
  });

  it('a same-key double-click converges to exactly one claim, entry and row', async () => {
    const { service, ledger, group, loan } = await makeRepayableLoan();
    const [a, b] = await Promise.allSettled([
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-same' }),
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-same' })
    ]);
    // The loser adopts/replays the twin — it never double-charges the loan.
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const final = await service.getLoan(loan.id);
    const repayments = await service.listRepayments(admin, loan.id);
    const receivable = await ledger.balance(groupLoansReceivableAccountCode(group.id));
    expect(repayments).toHaveLength(1);
    expect(final.repaidKobo).toBe(40_000);
    expect(receivable.balanceKobo).toBe(60_000);
  });

  it('rolls the claim back when the posting fails pre-commit, leaving no trace', async () => {
    const { service, ledger, loan } = await makeRepayableLoan();
    const original = ledger.postEntry.bind(ledger);
    let sabotaged = true;
    ledger.postEntry = ((input: Parameters<LedgerService['postEntry']>[0], actorId: string) =>
      sabotaged
        ? Promise.reject(new Error('ledger down'))
        : original(input, actorId)) as LedgerService['postEntry'];
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-x' })
    ).rejects.toThrow('ledger down');
    // The claim was rolled back: no money moved and the aggregate is clean.
    expect((await service.getLoan(loan.id)).repaidKobo).toBe(0);
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(0);
    // A same-key retry after recovery succeeds cleanly (no trapped claim).
    sabotaged = false;
    const retried = await service.repayLoan(farmer, loan.id, {
      amountKobo: 40_000,
      idempotencyKey: 'repay-x'
    });
    expect(retried.loan.repaidKobo).toBe(40_000);
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(1);
  });

  it('resume after a crash between posting and row insert adopts the entry (no double claim)', async () => {
    const { service, ledger, group, loan, repayments } = await makeRepayableLoan();
    const originalCreate = repayments.create.bind(repayments);
    let sabotaged = true;
    repayments.create = ((record: Parameters<typeof originalCreate>[0]) =>
      sabotaged ? Promise.reject(new Error('db down')) : originalCreate(record)) as typeof repayments.create;
    // Crash AFTER the ledger posting commits but BEFORE the repayment row.
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-crash' })
    ).rejects.toThrow('db down');
    // The claim stays standing (it matches the committed entry); the row is missing.
    expect((await service.getLoan(loan.id)).repaidKobo).toBe(40_000);
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(0);
    // Retry with the same key: resumes through the prior-entry path — no
    // second claim, no second posting, just the missing row.
    sabotaged = false;
    const resumed = await service.repayLoan(farmer, loan.id, {
      amountKobo: 40_000,
      idempotencyKey: 'repay-crash'
    });
    expect(resumed.loan.repaidKobo).toBe(40_000);
    const rows = await service.listRepayments(admin, loan.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountKobo).toBe(40_000);
    const receivable = await ledger.balance(groupLoansReceivableAccountCode(group.id));
    expect(receivable.balanceKobo).toBe(60_000); // ledger, row and loan agree
  });
});

describe('deterministic share-out at cycle close', () => {
  it('pays out pro-rata, zeroes the pool, and conserves the total', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const report = await service.closeCycle(lead, cycle.id);
    expect(report.replayed).toBe(false);
    expect(report.distributableKobo).toBe(400_000);
    expect(report.payouts.reduce((sum, p) => sum + p.shareKobo, 0)).toBe(400_000);
    expect(report.payouts.find((p) => p.memberId === leadMember.id)?.shareKobo).toBe(100_000);
    expect(report.payouts.find((p) => p.memberId === member2.id)?.shareKobo).toBe(300_000);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
    expect(
      (await ledger.balance(memberSavingsAccountCode(group.id, farmer.id))).balanceKobo
    ).toBe(0);
  });

  it('V-10: defaults the open loan at close and nets the arrears from the borrower share', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-key-8'
    });
    const report = await service.closeCycle(lead, cycle.id);
    // The loan was DEFAULTED at close (not silently socialised)…
    expect(report.defaultedLoanIds).toEqual([loan.id]);
    // …then the borrower's gross 225k share was netted by the 100k arrears:
    // 100k recovered against the claim, 125k paid in cash.
    expect(report.arrearsRecoveredKobo).toBe(100_000);
    expect(report.distributableKobo).toBe(300_000);
    const farmerPayout = report.payouts.find((p) => p.memberId === member2.id);
    const leadPayout = report.payouts.find((p) => p.memberId === leadMember.id);
    expect(farmerPayout?.shareKobo).toBe(125_000);
    expect(farmerPayout?.arrearsWithheldKobo).toBe(100_000);
    expect(farmerPayout?.residualKobo).toBe(75_000);
    // The non-borrowing member is NOT touched — no socialised loss.
    expect(leadPayout?.shareKobo).toBe(75_000);
    expect(leadPayout?.arrearsWithheldKobo).toBe(0);
    expect(leadPayout?.residualKobo).toBe(25_000);
    // The recovery fully settled the loan (claim recorded, receivable cleared).
    const settled = await service.getLoan(loan.id);
    expect(settled.status).toBe('REPAID');
    expect(settled.repaidKobo).toBe(100_000);
    const recoveries = await service.listRepayments(admin, loan.id);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].idempotencyKey).toBe(`shareout-arrears:${cycle.id}:${loan.id}`);
    // Residual stays visible on the member liability account (deferred share).
    const liability = await ledger.balance(memberSavingsAccountCode(group.id, farmer.id));
    expect(liability.creditsKobo - liability.debitsKobo).toBe(75_000);
    expect(
      (await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo
    ).toBe(0);
  });

  it('V-10: arrears beyond the share stay DEFAULTED and carry the claim into the next cycle', async () => {
    const { service } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    // Borrower (lead, 100k contributed) takes a 100k loan LARGER than their
    // 75k gross share of the 300k post-loan pool.
    const loan = await service.issueLoan(lead, group.id, {
      memberId: leadMember.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-carry'
    });
    const first = await service.closeCycle(lead, cycle.id);
    const leadPayout = first.payouts.find((p) => p.memberId === leadMember.id);
    expect(leadPayout?.shareKobo).toBe(0);
    expect(leadPayout?.arrearsWithheldKobo).toBe(75_000);
    expect(first.arrearsRecoveredKobo).toBe(75_000);
    // …the remaining 25k claim persists as DEFAULTED.
    const afterFirst = await service.getLoan(loan.id);
    expect(afterFirst.status).toBe('DEFAULTED');
    expect(afterFirst.repaidKobo).toBe(75_000);

    // Next cycle: the borrower keeps contributing; the carried claim is
    // netted again at the next close (75k residual cash sits in the pool too).
    const cycle2 = await service.openCycle(lead, group.id, 'Cycle 2');
    await service.contribute(lead, cycle2.id, {
      memberId: leadMember.id,
      amountKobo: 200_000,
      idempotencyKey: 'c2-lead'
    });
    const second = await service.closeCycle(lead, cycle2.id);
    const secondPayout = second.payouts.find((p) => p.memberId === leadMember.id);
    expect(secondPayout?.arrearsWithheldKobo).toBe(25_000);
    expect(secondPayout?.shareKobo).toBe(250_000);
    const settled = await service.getLoan(loan.id);
    expect(settled.status).toBe('REPAID');
    expect(settled.repaidKobo).toBe(100_000);
  });

  it('V-10: writeOffLoan books the loss as bad-debt expense and extinguishes the claim', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 50_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-wo'
    });
    // Only DEFAULTED loans can be written off (ACTIVE is premature).
    await expect(service.writeOffLoan(lead, loan.id)).rejects.toThrow(ConflictException);
    await service.closeCycle(lead, cycle.id); // nets the 50k from member2's share → REPAID
    expect((await service.getLoan(loan.id)).status).toBe('REPAID');

    // Second cycle: the borrower (leadMember) has NO contribution, so no
    // share exists to net — the loan defaults and stays defaulted.
    const cycle2 = await service.openCycle(lead, group.id, 'Cycle 2');
    await service.contribute(farmer, cycle2.id, {
      memberId: member2.id,
      amountKobo: 100_000,
      idempotencyKey: 'c2-farmer'
    });
    const loan2 = await service.issueLoan(lead, group.id, {
      memberId: leadMember.id,
      principalKobo: 20_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-wo-2'
    });
    await service.closeCycle(lead, cycle2.id);
    expect((await service.getLoan(loan2.id)).status).toBe('DEFAULTED');
    const writtenOff = await service.writeOffLoan(lead, loan2.id);
    expect(writtenOff.status).toBe('WRITTEN_OFF');
    // The loss is explicit: bad_debt expense carries the outstanding claim.
    expect((await ledger.balance(groupBadDebtAccountCode(group.id))).balanceKobo).toBe(20_000);
    expect(
      (await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo
    ).toBe(0);
    // Replay-safe and terminal; no more repayments accepted.
    expect((await service.writeOffLoan(lead, loan2.id)).status).toBe('WRITTEN_OFF');
    await expect(
      service.repayLoan(lead, loan2.id, { amountKobo: 1, idempotencyKey: 'r-wo' })
    ).rejects.toThrow(ConflictException);
    // A farmer cannot write off (group admin only).
    await expect(service.writeOffLoan(farmer, loan2.id)).rejects.toThrow(ForbiddenException);
  });

  it('V-47: dissolve is blocked by an open cycle, outstanding loans or pooled cash', async () => {
    const { service } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    // Open cycle blocks dissolve.
    await expect(service.dissolveGroup(lead, group.id)).rejects.toThrow(ConflictException);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 50_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-dis'
    });
    await service.closeCycle(lead, cycle.id); // nets 50k from member2's share → REPAID
    expect((await service.getLoan(loan.id)).status).toBe('REPAID');
    // Pooled cash remains (residual claims 25k + 75k) → still blocked.
    await expect(service.dissolveGroup(lead, group.id)).rejects.toThrow(ConflictException);
    // Settle both members via exit, then dissolve succeeds.
    await service.exitGroup(lead, group.id);
    await service.exitGroup(farmer, group.id);
    const dissolved = await service.dissolveGroup(lead, group.id);
    expect(dissolved.status).toBe('DISSOLVED');
    // Replay-safe and terminal: no new cycles on a dissolved group.
    expect((await service.dissolveGroup(lead, group.id)).status).toBe('DISSOLVED');
    await expect(service.openCycle(lead, group.id, 'Nope')).rejects.toThrow(ConflictException);
    // A non-admin member cannot dissolve.
    await expect(service.dissolveGroup(farmer2, group.id)).rejects.toThrow(ForbiddenException);
  });

  it('V-47: member exit is blocked by open cycle/outstanding loan and settles shares', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    // Open cycle locks exit (contributions are in the pool).
    await expect(service.exitGroup(farmer, group.id)).rejects.toThrow(ConflictException);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 50_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-exit'
    });
    await service.closeCycle(lead, cycle.id); // loan netted from member2's share
    // member2 owes nothing (50k netted); their residual claim is 75k.
    const exited = await service.exitGroup(farmer, group.id);
    expect(exited.status).toBe('EXITED');
    // Settlement drained the member liability account to zero…
    const settled = await ledger.balance(memberSavingsAccountCode(group.id, farmer.id));
    expect(settled.creditsKobo - settled.debitsKobo).toBe(0);
    // …and replay is safe.
    expect((await service.exitGroup(farmer, group.id)).status).toBe('EXITED');
    // Non-members and cross-member exits fail closed (farmer2 is no admin).
    await expect(service.exitGroup(farmer2, group.id)).rejects.toThrow(NotFoundException);
    await expect(service.exitGroup(farmer2, group.id, member2.id)).rejects.toThrow(
      ForbiddenException
    );
    // An admin may exit another member by id.
    const leadExited = await service.exitGroup(admin, group.id, leadMember.id);
    expect(leadExited.status).toBe('EXITED');
    void loan;
  });

  it('V-47: a member with an outstanding DEFAULTED loan cannot exit until settled', async () => {
    const { service } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    // Only member2 contributes; leadMember borrows → no share to net at close.
    await service.contribute(farmer, cycle.id, {
      memberId: member2.id,
      amountKobo: 100_000,
      idempotencyKey: 'c-exit-block'
    });
    const loan = await service.issueLoan(lead, group.id, {
      memberId: leadMember.id,
      principalKobo: 20_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-exit-block'
    });
    await service.closeCycle(lead, cycle.id);
    expect((await service.getLoan(loan.id)).status).toBe('DEFAULTED');
    await expect(service.exitGroup(lead, group.id)).rejects.toThrow(ConflictException);
    // Repay the claim (DEFAULTED loans stay repayable, V-10) → exit opens.
    await service.repayLoan(lead, loan.id, { amountKobo: 20_000, idempotencyKey: 'r-exit' });
    const exited = await service.exitGroup(lead, group.id);
    expect(exited.status).toBe('EXITED');
  });

  it('V-48: dual-attested cash counts post audited variance adjustments', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id); // 400k in the pool

    // Meetings are member-scoped governance anchors.
    const meeting = await service.recordMeeting(farmer, group.id, { notes: 'Weekly' });
    expect(meeting.groupId).toBe(group.id);
    await expect(service.recordMeeting(farmer2, group.id, {})).rejects.toThrow(ForbiddenException);

    // Only the treasurer (group admin) declares; a member cannot.
    await expect(
      service.declareCashCount(farmer, group.id, { declaredKobo: 400_000, idempotencyKey: 'cc-0' })
    ).rejects.toThrow(ForbiddenException);

    // Exact count: attested, no adjustment entry.
    const exact = await service.declareCashCount(lead, group.id, {
      declaredKobo: 400_000,
      meetingId: meeting.id,
      idempotencyKey: 'cc-1'
    });
    expect(exact.status).toBe('PENDING');
    // Idempotent declaration replay.
    expect(
      (await service.declareCashCount(lead, group.id, { declaredKobo: 400_000, idempotencyKey: 'cc-1' })).id
    ).toBe(exact.id);
    // Dual attestation: the declarer cannot self-attest.
    await expect(service.attestCashCount(lead, exact.id)).rejects.toThrow(ForbiddenException);
    const attestedExact = await service.attestCashCount(farmer, exact.id);
    expect(attestedExact.status).toBe('ATTESTED');
    expect(attestedExact.varianceKobo).toBe(0);
    expect(attestedExact.ledgerEntryId).toBeUndefined();

    // Shortage beyond the flag threshold (5% of 400k = 20k): FLAGGED + entry.
    const short = await service.declareCashCount(lead, group.id, {
      declaredKobo: 360_000,
      idempotencyKey: 'cc-2'
    });
    const flagged = await service.attestCashCount(admin, short.id);
    expect(flagged.status).toBe('FLAGGED');
    expect(flagged.ledgerKobo).toBe(400_000);
    expect(flagged.varianceKobo).toBe(-40_000);
    expect(flagged.attestedBy).toBe(admin.id);
    // Balanced adjustment: book cash reduced, loss expensed explicitly.
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(360_000);
    const shortageAccount = await ledger.balance(groupCashShortageAccountCode(group.id));
    expect(shortageAccount.debitsKobo - shortageAccount.creditsKobo).toBe(40_000);
    // Attestation replay: no second entry, same record.
    const replay = await service.attestCashCount(farmer, short.id);
    expect(replay.status).toBe('FLAGGED');
    const entries = await ledger.listEntries({
      referenceType: 'vsla_cash_count',
      referenceId: short.id
    });
    expect(entries).toHaveLength(1);
    // Reads are membership-scoped (V-13 pattern).
    await expect(service.listCashCounts(farmer2, group.id)).rejects.toThrow(ForbiddenException);
    await expect(service.listCashCounts(farmer, group.id)).resolves.toHaveLength(2);
  });

  it('distributes an interest surplus pro-rata and zeroes interest income', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 1_000,
      idempotencyKey: 'issue-key-9'
    });
    await service.repayLoan(farmer, loan.id, { amountKobo: 110_000, idempotencyKey: 'full' });
    const report = await service.closeCycle(lead, cycle.id);
    expect(report.distributableKobo).toBe(410_000);
    expect(report.payouts.reduce((sum, p) => sum + p.shareKobo, 0)).toBe(410_000);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
    expect(
      (await ledger.balance(groupInterestIncomeAccountCode(group.id))).balanceKobo
    ).toBe(0);
    expect(
      (await ledger.balance(memberSavingsAccountCode(group.id, farmer.id))).balanceKobo
    ).toBe(0);
  });

  it('replays the close idempotently (same report, ledger untouched)', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const first = await service.closeCycle(lead, cycle.id);
    const replay = await service.closeCycle(lead, cycle.id);
    expect(replay.replayed).toBe(true);
    expect(replay.payouts.map((p) => [p.memberId, p.shareKobo])).toEqual(
      first.payouts.map((p) => [p.memberId, p.shareKobo])
    );
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
    expect(await service.getShareOut(admin, cycle.id)).toHaveLength(2);
  });

  it('requires a group admin to close a cycle', async () => {
    const { service } = makeService();
    const { cycle } = await makeGroupWithCycle(service);
    await expect(service.closeCycle(farmer, cycle.id)).rejects.toThrow(ForbiddenException);
  });
});

describe('stage-24 audit regression: closeCycle crash-resume pays the persisted plan (A4-4)', () => {
  it('crash after the first payout: resume pays remaining members their ORIGINAL shares', async () => {
    const { service, ledger, shareOuts } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    // Equal contributions: the fair close pays 100k to each member.
    await contributeBoth(service, cycle.id, leadMember.id, member2.id, [100_000, 100_000]);

    // Sabotage the FIRST share-out row insert: the ledger entry for the lead
    // member commits, then the process "dies" before the row is recorded.
    const originalCreate = shareOuts.create.bind(shareOuts);
    let sabotaged = true;
    shareOuts.create = ((record: Parameters<typeof originalCreate>[0]) =>
      sabotaged
        ? Promise.reject(new Error('process crash'))
        : originalCreate(record)) as typeof shareOuts.create;
    await expect(service.closeCycle(lead, cycle.id)).rejects.toThrow('process crash');

    // Mid-crash state: the plan is persisted, one payout posted, no rows.
    expect(await service.getShareOut(admin, cycle.id)).toHaveLength(0);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(100_000);

    // Resume: shares come from the PERSISTED plan, not the reduced pool.
    sabotaged = false;
    const resumed = await service.closeCycle(lead, cycle.id);
    expect(resumed.replayed).toBe(true);
    expect(resumed.distributableKobo).toBe(200_000); // not the reduced 100k
    const leadPayout = resumed.payouts.find((p) => p.memberId === leadMember.id);
    const farmerPayout = resumed.payouts.find((p) => p.memberId === member2.id);
    expect(leadPayout?.shareKobo).toBe(100_000); // original share, matching the posted entry
    expect(farmerPayout?.shareKobo).toBe(100_000); // B paid in full — no underpayment
    // The recorded row points at the ORIGINAL ledger entry (same amount).
    expect(leadPayout?.ledgerEntryId).not.toBe('');
    // Conservation holds and nothing is stranded in the pool.
    expect(resumed.payouts.reduce((sum, p) => sum + p.shareKobo, 0)).toBe(200_000);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
    expect(await service.getShareOut(admin, cycle.id)).toHaveLength(2);

    // A further close is a clean replay of the same report.
    const replay = await service.closeCycle(lead, cycle.id);
    expect(replay.distributableKobo).toBe(200_000);
    expect(replay.payouts.map((p) => [p.memberId, p.shareKobo])).toEqual(
      resumed.payouts.map((p) => [p.memberId, p.shareKobo])
    );
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
  });

  it('concurrent closers converge on one persisted plan and one payout per member', async () => {
    const { service, ledger, group, cycle } = await (async () => {
      const ctx = makeService();
      const fixture = await makeGroupWithCycle(ctx.service);
      await contributeBoth(ctx.service, fixture.cycle.id, fixture.leadMember.id, fixture.member2.id);
      return { ...ctx, ...fixture };
    })();
    const results = await Promise.allSettled([
      service.closeCycle(lead, cycle.id),
      service.closeCycle(lead, cycle.id)
    ]);
    // At most one closer wins the OPEN→CLOSED CAS; a loser 409s BEFORE any
    // payout posts, and its retry replays the persisted plan cleanly.
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ConflictException);
      }
    }
    await service.closeCycle(lead, cycle.id);
    const rows = await service.getShareOut(admin, cycle.id);
    expect(rows).toHaveLength(2); // exactly one payout row per member
    expect(rows.reduce((sum, row) => sum + row.shareKobo, 0)).toBe(400_000);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
  });
});

describe('carbon MRV plots + seasonal evidence', () => {
  it('registers a plot with an app-layer H3 res-9 index and centi-hectares', async () => {
    const { service } = makeService();
    const { group } = await makeGroupWithCycle(service);
    const plot = await service.registerPlot(lead, {
      groupId: group.id,
      ownerUserId: farmer.id,
      name: 'FMNR plot A',
      practiceType: 'fmnr',
      hectares: 2.5,
      centroidLat: 11.0855,
      centroidLong: 7.7199
    });
    expect(plot.hectaresCenti).toBe(250);
    expect(plot.h3Res9).toMatch(/^[0-9a-f]{15}$/);
    expect(plot.status).toBe('ACTIVE');
  });

  it('validates coordinates fail-closed and blocks non-member plot registration', async () => {
    const { service } = makeService();
    const { group } = await makeGroupWithCycle(service);
    await expect(
      service.registerPlot(lead, {
        groupId: group.id,
        name: 'bad',
        practiceType: 'woodlot',
        hectares: 1,
        centroidLat: 123,
        centroidLong: 7
      })
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.registerPlot(farmer2, {
        groupId: group.id,
        name: 'intruder',
        practiceType: 'woodlot',
        hectares: 1,
        centroidLat: 11,
        centroidLong: 7
      })
    ).rejects.toThrow(ForbiddenException);
  });

  it('records seasonal evidence with the submitter role label, idempotently', async () => {
    const { service } = makeService();
    const { group } = await makeGroupWithCycle(service);
    const plot = await service.registerPlot(lead, {
      groupId: group.id,
      ownerUserId: farmer.id,
      name: 'A',
      practiceType: 'agroforestry',
      hectares: 1,
      centroidLat: 11,
      centroidLong: 7
    });
    const first = await service.submitEvidence(enumerator, plot.id, {
      season: '2026-wet',
      survivalRatePct: 85,
      idempotencyKey: 'e1'
    });
    expect(first.submitterRole).toBe('enumerator');
    const replay = await service.submitEvidence(enumerator, plot.id, {
      season: '2026-wet',
      survivalRatePct: 85,
      idempotencyKey: 'e1'
    });
    expect(replay.id).toBe(first.id);
    expect(await service.listEvidence(admin, plot.id)).toHaveLength(1);
    await expect(
      service.submitEvidence(farmer, plot.id, {
        season: 'not-a-season',
        idempotencyKey: 'e2'
      })
    ).rejects.toThrow(BadRequestException);
  });

  it('links NDVI via the crop-ml contract with the basis stored verbatim (stub)', async () => {
    const { service } = makeService();
    const { group } = await makeGroupWithCycle(service);
    const plot = await service.registerPlot(lead, {
      groupId: group.id,
      ownerUserId: farmer.id,
      name: 'A',
      practiceType: 'fmnr',
      hectares: 1,
      centroidLat: 11,
      centroidLong: 7
    });
    const evidence = await service.submitEvidence(farmer, plot.id, {
      season: '2026-wet',
      idempotencyKey: 'ndvi-1',
      linkNdvi: true
    });
    expect(evidence.ndviBasis).toBe('stub');
    expect(evidence.ndviHealthScore).toBe(64);
    expect(evidence.ndviClassification).toBe('normal');
  });

  it('fails closed in production: stub NDVI never lands on a carbon evidence record (WP-G15)', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { service } = makeService(); // default stub NDVI provider
      const { group } = await makeGroupWithCycle(service);
      const plot = await service.registerPlot(lead, {
        groupId: group.id,
        ownerUserId: farmer.id,
        name: 'A',
        practiceType: 'fmnr',
        hectares: 1,
        centroidLat: 11,
        centroidLong: 7
      });
      await expect(
        service.submitEvidence(farmer, plot.id, {
          season: '2026-wet',
          idempotencyKey: 'ndvi-prod',
          linkNdvi: true
        })
      ).rejects.toThrow(ServiceUnavailableException);
      // Fail closed: NO evidence row was written.
      expect(await service.listEvidence(admin, plot.id)).toHaveLength(0);

      // The endpoint stays functional in production without the stub
      // linkage (real farmer-supplied inputs persist fine).
      const evidence = await service.submitEvidence(farmer, plot.id, {
        season: '2026-wet',
        survivalRatePct: 80,
        idempotencyKey: 'ndvi-prod-plain'
      });
      expect(evidence.ndviBasis).toBeUndefined();
      expect(await service.listEvidence(admin, plot.id)).toHaveLength(1);
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });

  it('fails closed with 503 when the NDVI provider is unreachable (no evidence written)', async () => {
    const failingNdvi: NdviProvider = {
      name: 'http',
      assess: () => Promise.reject(new ProviderRequestError('crop-ml', 'network', new Error('down'))),
      status: () => Promise.resolve({ configured: true, healthy: false, detail: 'down' })
    };
    const { service } = makeService(failingNdvi);
    const { group } = await makeGroupWithCycle(service);
    const plot = await service.registerPlot(lead, {
      groupId: group.id,
      ownerUserId: farmer.id,
      name: 'A',
      practiceType: 'fmnr',
      hectares: 1,
      centroidLat: 11,
      centroidLong: 7
    });
    await expect(
      service.submitEvidence(farmer, plot.id, {
        season: '2026-wet',
        idempotencyKey: 'ndvi-fail',
        linkNdvi: true
      })
    ).rejects.toThrow(ServiceUnavailableException);
    expect(await service.listEvidence(admin, plot.id)).toHaveLength(0);
  });
});

describe('carbon ESTIMATEs + donor/MRV reporting', () => {
  async function plotWithEvidence(service: VslaCarbonService) {
    const { group } = await makeGroupWithCycle(service);
    const plot = await service.registerPlot(lead, {
      groupId: group.id,
      ownerUserId: farmer.id,
      name: 'FMNR plot',
      practiceType: 'fmnr',
      hectares: 2,
      centroidLat: 11,
      centroidLong: 7
    });
    await service.submitEvidence(enumerator, plot.id, {
      season: '2026-wet',
      survivalRatePct: 80,
      idempotencyKey: 'ev-wet',
      linkNdvi: true
    });
    await service.submitEvidence(farmer, plot.id, {
      season: '2026-dry',
      survivalRatePct: 75,
      idempotencyKey: 'ev-dry'
    });
    return { group, plot };
  }

  it('computes a deterministic estimate from the versioned table (basis estimate)', async () => {
    const { service } = makeService();
    const { plot } = await plotWithEvidence(service);
    const estimate = await service.estimatePlot(enumerator, plot.id, '2026-dry');
    expect(estimate.coefficientVersion).toBe(CO2E_COEFFICIENT_VERSION);
    expect(estimate.basis).toBe('estimate');
    // 2 ha FMNR (3 t/ha/yr) * 75% survival * 2 seasons = 9 t
    expect(estimate.survivalRatePct).toBe(75);
    expect(estimate.seasonCount).toBe(2);
    expect(estimate.co2eMilliTonnes).toBe(9_000);
  });

  it('replays estimates idempotently per plot+season+version', async () => {
    const { service } = makeService();
    const { plot } = await plotWithEvidence(service);
    const first = await service.estimatePlot(enumerator, plot.id, '2026-dry');
    const replay = await service.estimatePlot(enumerator, plot.id, '2026-dry');
    expect(replay.id).toBe(first.id);
    expect(await service.listEstimates(admin, plot.id)).toHaveLength(1);
  });

  it('defaults survival to 100% when no evidence exists (still an estimate)', async () => {
    const { service } = makeService();
    const { group } = await makeGroupWithCycle(service);
    const plot = await service.registerPlot(lead, {
      groupId: group.id,
      ownerUserId: farmer.id,
      name: 'bare',
      practiceType: 'woodlot',
      hectares: 1,
      centroidLat: 11,
      centroidLong: 7
    });
    const estimate = await service.estimatePlot(lead, plot.id, '2026-wet');
    expect(estimate.survivalRatePct).toBe(100);
    expect(estimate.co2eMilliTonnes).toBe(6_000);
  });

  it('aggregates a group MRV report with basis flags and the estimate disclaimer', async () => {
    const { service } = makeService();
    const { group, plot } = await plotWithEvidence(service);
    await service.estimatePlot(enumerator, plot.id, '2026-dry');
    const report = await service.groupMrvReport(group.id);
    expect(report.plotCount).toBe(1);
    expect(report.hectaresUnderPractice).toBe(2);
    expect(report.meanSurvivalRatePct).toBe(75);
    expect(report.estimatedCo2eTonnes).toBe(9);
    expect(report.evidenceCount).toBe(2);
    expect(report.ndviLinkedEvidenceCount).toBe(1);
    expect(report.basisFlags).toEqual(['stub', 'estimate']);
    expect(report.disclaimer).toBe(ESTIMATE_DISCLAIMER);
  });

  it('aggregates a programme report across groups', async () => {
    const { service } = makeService();
    const { plot } = await plotWithEvidence(service);
    await service.estimatePlot(enumerator, plot.id, '2026-dry');
    const report = await service.programmeMrvReport();
    expect(report.groupCount).toBe(1);
    expect(report.estimatedCo2eTonnes).toBe(9);
    expect(report.basisFlags).toEqual(['stub', 'estimate']);
    expect(report.disclaimer).toContain('not verification-grade');
    expect(report.groups[0]?.groupName).toBe('Kano Women Savings');
  });

  it('exposes the versioned coefficient table for transparency', () => {
    const { service } = makeService();
    const view = service.listCoefficients();
    expect(view.version).toBe(CO2E_COEFFICIENT_VERSION);
    expect(view.coefficients.length).toBeGreaterThanOrEqual(4);
    expect(view.coefficients.every((c) => c.source.includes('IPCC') || c.source.length > 10)).toBe(
      true
    );
  });

  it('never claims verification-grade figures anywhere in the report shape', async () => {
    const { service } = makeService();
    const { group, plot } = await plotWithEvidence(service);
    await service.estimatePlot(enumerator, plot.id, '2026-dry');
    const report = await service.groupMrvReport(group.id);
    const serialized = JSON.stringify(report).toLowerCase();
    expect(serialized).not.toContain('verified credit');
    expect(serialized).not.toContain('credits issued');
    expect(serialized).toContain('estimate');
  });
});

/* ------------------------------------------------------------------------
 * WP-G1 (stage-27 V2 funds-atomicity audit): VSLA money-path fixes.
 *  - issueLoan is exactly-once by client idempotency key (no more
 *    double-disbursement on transport retry);
 *  - repayment claim + ledger posting + repayment row are one unit of work
 *    (no phantom REPAID claims), with a reconciler for legacy crash states;
 *  - the close-cycle distribution plan commits with a completion marker, so
 *    a crash mid-insert is rebuilt, never paid out partially.
 * ---------------------------------------------------------------------- */

describe('WP-G1: issueLoan idempotency (double-disbursement fix)', () => {
  async function makeFundedGroup() {
    const ctx = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(ctx.service);
    await contributeBoth(ctx.service, cycle.id, leadMember.id, member2.id);
    return { ...ctx, group, cycle, leadMember, member2 };
  }

  it('requires an idempotency key (fail closed on the money path)', async () => {
    const { service, group, member2 } = await makeFundedGroup();
    await expect(
      service.issueLoan(lead, group.id, {
        memberId: member2.id,
        principalKobo: 10_000,
        interestRateBps: 0,
        idempotencyKey: ''
      })
    ).rejects.toThrow(BadRequestException);
    expect(await service.listLoans(admin, group.id)).toHaveLength(0);
  });

  it('concurrent duplicate issueLoan with the same key disburses EXACTLY once', async () => {
    const { service, ledger, group, member2 } = await makeFundedGroup();
    const input = {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'loan-dup-key'
    };
    const [a, b] = await Promise.allSettled([
      service.issueLoan(lead, group.id, input),
      service.issueLoan(lead, group.id, { ...input })
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const first = (a as PromiseFulfilledResult<Awaited<ReturnType<typeof service.issueLoan>>>).value;
    const second = (b as PromiseFulfilledResult<Awaited<ReturnType<typeof service.issueLoan>>>).value;
    // Both callers converge on the SAME loan — no double disbursement.
    expect(second.id).toBe(first.id);
    expect(await service.listLoans(admin, group.id)).toHaveLength(1);
    // Exactly ONE balanced disbursement posting: pool debited once.
    const entries = await ledger.listEntries({ referenceType: 'vsla_loan' });
    expect(entries).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(300_000);
    expect((await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo).toBe(
      100_000
    );
  });

  it('a sequential transport retry with the same key replays the original loan', async () => {
    const { service, ledger, group, member2 } = await makeFundedGroup();
    const input = {
      memberId: member2.id,
      principalKobo: 50_000,
      interestRateBps: 1_000,
      idempotencyKey: 'loan-retry-key'
    };
    const first = await service.issueLoan(lead, group.id, input);
    const replay = await service.issueLoan(lead, group.id, { ...input });
    expect(replay.id).toBe(first.id);
    expect(replay.ledgerEntryId).toBe(first.ledgerEntryId);
    expect(await service.listLoans(admin, group.id)).toHaveLength(1);
    expect(await ledger.listEntries({ referenceType: 'vsla_loan' })).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(350_000);
  });

  it('same key with a different amount is a 409 and posts nothing new', async () => {
    const { service, ledger, group, member2 } = await makeFundedGroup();
    await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'loan-mismatch-key'
    });
    await expect(
      service.issueLoan(lead, group.id, {
        memberId: member2.id,
        principalKobo: 150_000, // same key, different payload
        interestRateBps: 0,
        idempotencyKey: 'loan-mismatch-key'
      })
    ).rejects.toThrow(ConflictException);
    // The conflicting retry moved no money and created no loan.
    expect(await service.listLoans(admin, group.id)).toHaveLength(1);
    expect(await ledger.listEntries({ referenceType: 'vsla_loan' })).toHaveLength(1);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(300_000);
  });

  it('same key with a different member is a 409', async () => {
    const { service, group, leadMember, member2 } = await makeFundedGroup();
    await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 10_000,
      interestRateBps: 0,
      idempotencyKey: 'loan-member-mismatch'
    });
    await expect(
      service.issueLoan(lead, group.id, {
        memberId: leadMember.id,
        principalKobo: 10_000,
        interestRateBps: 0,
        idempotencyKey: 'loan-member-mismatch'
      })
    ).rejects.toThrow(ConflictException);
  });

  it('a failed disbursement (insufficient pool) burns nothing and can be retried', async () => {
    const { service, ledger, group, cycle, leadMember, member2 } = await (async () => {
      const ctx = makeService();
      const fixture = await makeGroupWithCycle(ctx.service);
      await contributeBoth(
        ctx.service,
        fixture.cycle.id,
        fixture.leadMember.id,
        fixture.member2.id,
        [10_000, 10_000]
      );
      return { ...ctx, ...fixture };
    })();
    const input = {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'loan-underfunded'
    };
    await expect(service.issueLoan(lead, group.id, input)).rejects.toThrow(BadRequestException);
    expect(await service.listLoans(admin, group.id)).toHaveLength(0);
    // Fund the pool, then the SAME key retries cleanly into a real loan.
    await service.contribute(lead, cycle.id, {
      memberId: leadMember.id,
      amountKobo: 200_000,
      idempotencyKey: 'c-topup'
    });
    const retried = await service.issueLoan(lead, group.id, input);
    expect(retried.principalKobo).toBe(100_000);
    expect((await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo).toBe(
      100_000
    );
  });
});

describe('WP-G1: phantom repayment claim — reconciler + atomic fold', () => {
  async function makeRepayableLoan() {
    const ctx = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(ctx.service);
    await contributeBoth(ctx.service, cycle.id, leadMember.id, member2.id);
    const loan = await ctx.service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0,
      idempotencyKey: 'issue-phantom-fixture'
    });
    return { ...ctx, group, loan };
  }

  it('crash between claim and posting (pre-fold state): reconciler releases the phantom REPAID', async () => {
    const { service, loans, ledger, group, loan } = await makeRepayableLoan();
    // Simulate the pre-fold crash: the claim committed (loan flipped to
    // REPAID) but the process died BEFORE the ledger posting — the borrower
    // never paid, yet the loan looks settled and 409-locks any retry.
    await loans.claimRepayment(loan.id, 100_000);
    const stuck = await service.getLoan(loan.id);
    expect(stuck.status).toBe('REPAID');
    expect(stuck.repaidKobo).toBe(100_000);
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 100_000, idempotencyKey: 'after-crash' })
    ).rejects.toThrow(ConflictException);

    const corrections = await service.reconcileRepaymentClaims();
    expect(corrections).toEqual([{ loanId: loan.id, materialisedRows: 0, releasedKobo: 100_000 }]);

    // The phantom is released: the loan is ACTIVE again, no money moved, and
    // the borrower can actually repay.
    const healed = await service.getLoan(loan.id);
    expect(healed.status).toBe('ACTIVE');
    expect(healed.repaidKobo).toBe(0);
    expect(
      (await ledger.balance(groupLoansReceivableAccountCode(group.id))).balanceKobo
    ).toBe(100_000);
    const repaid = await service.repayLoan(farmer, loan.id, {
      amountKobo: 100_000,
      idempotencyKey: 'after-crash'
    });
    expect(repaid.loan.status).toBe('REPAID');
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(400_000);
  });

  it('reconciler re-drives a committed entry whose repayment row is missing', async () => {
    const { service, ledger, repayments, loan } = await makeRepayableLoan();
    // Crash AFTER the posting committed but BEFORE the row insert (claim,
    // entry — no row).
    const originalCreate = repayments.create.bind(repayments);
    let sabotaged = true;
    repayments.create = ((record: Parameters<typeof originalCreate>[0]) =>
      sabotaged
        ? Promise.reject(new Error('process crash'))
        : originalCreate(record)) as typeof repayments.create;
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 40_000, idempotencyKey: 'repay-crash-2' })
    ).rejects.toThrow('process crash');
    sabotaged = false;
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(0);
    expect((await service.getLoan(loan.id)).repaidKobo).toBe(40_000);

    const corrections = await service.reconcileRepaymentClaims();
    expect(corrections).toEqual([{ loanId: loan.id, materialisedRows: 1, releasedKobo: 0 }]);
    const rows = await service.listRepayments(admin, loan.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountKobo).toBe(40_000);
    // Claim, row and ledger agree — nothing was released (the money DID move).
    expect((await service.getLoan(loan.id)).repaidKobo).toBe(40_000);
    void ledger;
  });

  it('posting failure inside the folded unit leaves no claim, entry or row', async () => {
    const { service, ledger, loan } = await makeRepayableLoan();
    const original = ledger.postEntry.bind(ledger);
    let sabotaged = true;
    ledger.postEntry = ((input: Parameters<LedgerService['postEntry']>[0], actorId: string) =>
      sabotaged
        ? Promise.reject(new Error('ledger down'))
        : original(input, actorId)) as LedgerService['postEntry'];
    await expect(
      service.repayLoan(farmer, loan.id, { amountKobo: 60_000, idempotencyKey: 'repay-fold-fail' })
    ).rejects.toThrow('ledger down');
    // The unit rolled back cleanly: the loan is untouched and fully retryable.
    expect((await service.getLoan(loan.id)).repaidKobo).toBe(0);
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(0);
    sabotaged = false;
    const retried = await service.repayLoan(farmer, loan.id, {
      amountKobo: 60_000,
      idempotencyKey: 'repay-fold-fail'
    });
    expect(retried.loan.repaidKobo).toBe(60_000);
    expect(await service.listRepayments(admin, loan.id)).toHaveLength(1);
    // A healthy loan shows up as NO correction in the reconciler.
    expect(await service.reconcileRepaymentClaims()).toEqual([]);
  });
});

describe('WP-G1: share-out plan completion marker (partial-plan fix)', () => {
  it('a crash mid plan-insert (partial plan, no marker) is rebuilt and pays ALL members', async () => {
    const { service, ledger, shareOutPlan } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id, [100_000, 300_000]);
    // Simulate the pre-054 crash: ONE plan row persisted in autocommit before
    // the process died — no completion marker, no payout posted. The old
    // resume treated this partial plan as complete and underpaid member2.
    await shareOutPlan.create({
      id: 'plan-partial-lead',
      cycleId: cycle.id,
      memberId: leadMember.id,
      shareKobo: 100_000,
      contributedKobo: 100_000,
      residualKobo: 0,
      createdAt: new Date().toISOString()
    });

    const report = await service.closeCycle(lead, cycle.id);
    // The partial plan was discarded and rebuilt: BOTH members are paid.
    expect(report.payouts).toHaveLength(2);
    expect(report.distributableKobo).toBe(400_000);
    expect(report.payouts.find((p) => p.memberId === leadMember.id)?.shareKobo).toBe(100_000);
    expect(report.payouts.find((p) => p.memberId === member2.id)?.shareKobo).toBe(300_000);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
    // The rebuilt plan carries its completion marker.
    const meta = await shareOutPlan.findMeta(cycle.id);
    expect(meta).toMatchObject({ cycleId: cycle.id, rowCount: 2, totalShareKobo: 400_000 });
    expect(await shareOutPlan.find({ cycleId: cycle.id })).toHaveLength(2);
  });

  it('a legacy plan WITH recorded payouts is backfilled (marker), never recomputed from the reduced pool', async () => {
    const { service, ledger, shareOuts, shareOutPlan } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    // Equal contributions: the fair close pays 100k to each member.
    await contributeBoth(service, cycle.id, leadMember.id, member2.id, [100_000, 100_000]);
    // Legacy (pre-054) crash state: the full plan persisted WITHOUT a marker,
    // and the lead member's payout already posted (pool now holds 100k).
    const now = new Date().toISOString();
    for (const member of [leadMember, member2]) {
      await shareOutPlan.create({
        id: `legacy-plan-${member.id}`,
        cycleId: cycle.id,
        memberId: member.id,
        shareKobo: 100_000,
        contributedKobo: 100_000,
        residualKobo: 0,
        createdAt: now
      });
    }
    const leadEntry = await ledger.postEntry(
      {
        idempotencyKey: `vsla-shareout:${cycle.id}:${leadMember.id}`,
        referenceType: 'vsla_share_out',
        referenceId: cycle.id,
        description: 'legacy payout',
        postings: [
          {
            accountCode: memberSavingsAccountCode(group.id, lead.id),
            direction: 'debit',
            amountKobo: 100_000
          },
          {
            accountCode: groupCashAccountCode(group.id),
            direction: 'credit',
            amountKobo: 100_000
          }
        ],
        requireSolventAccounts: [groupCashAccountCode(group.id)]
      },
      lead.id
    );
    await shareOuts.create({
      id: 'legacy-shareout-lead',
      cycleId: cycle.id,
      memberId: leadMember.id,
      shareKobo: 100_000,
      contributedKobo: 100_000,
      residualKobo: 0,
      ledgerEntryId: leadEntry.id,
      createdAt: now
    });

    const report = await service.closeCycle(lead, cycle.id);
    // member2 is paid the ORIGINAL 100k share — not a share recomputed from
    // the reduced 100k pool — and the plan gained its completion marker.
    expect(report.payouts).toHaveLength(2);
    expect(report.payouts.find((p) => p.memberId === member2.id)?.shareKobo).toBe(100_000);
    expect(report.distributableKobo).toBe(200_000);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
    expect(await shareOutPlan.findMeta(cycle.id)).toMatchObject({ rowCount: 2 });
  });

  it('concurrent closers write exactly ONE plan and pay every member once', async () => {
    const { service, ledger, shareOutPlan } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id, [100_000, 300_000]);
    // The OPEN→CLOSED CAS elects a single closer; the loser 409s and its
    // retry replays the winner's close (single-closer doctrine).
    const [a, b] = await Promise.allSettled([
      service.closeCycle(lead, cycle.id),
      service.closeCycle(lead, cycle.id)
    ]);
    const winner = (a.status === 'fulfilled' ? a : b) as PromiseFulfilledResult<
      Awaited<ReturnType<typeof service.closeCycle>>
    >;
    const loserReplay = await service.closeCycle(lead, cycle.id);
    expect(winner.value.payouts.map((p) => [p.memberId, p.shareKobo].join(':'))).toEqual(
      loserReplay.payouts.map((p) => [p.memberId, p.shareKobo].join(':'))
    );
    // One marker, two plan rows, two payout rows, pool fully distributed.
    expect(await shareOutPlan.findMeta(cycle.id)).toMatchObject({ rowCount: 2 });
    expect(await shareOutPlan.find({ cycleId: cycle.id })).toHaveLength(2);
    expect(await service.getShareOut(admin, cycle.id)).toHaveLength(2);
    expect((await ledger.balance(groupCashAccountCode(group.id))).balanceKobo).toBe(0);
  });
});
