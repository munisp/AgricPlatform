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
  createInMemoryVslaMemberRepository,
  createInMemoryVslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { ProviderRequestError } from '../integrations/drivers/http.js';
import { CO2E_COEFFICIENT_VERSION } from './carbon-coefficients.js';
import type { NdviProvider } from './ndvi.provider.js';
import {
  ESTIMATE_DISCLAIMER,
  groupCashAccountCode,
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
  const service = new VslaCarbonService(
    createInMemoryVslaGroupRepository(),
    createInMemoryVslaMemberRepository(),
    createInMemoryVslaCycleRepository(),
    createInMemoryVslaContributionRepository(),
    createInMemoryVslaShareOutRepository(),
    createInMemoryVslaLoanRepository(),
    createInMemoryVslaLoanRepaymentRepository(),
    createInMemoryCarbonPlotRepository(),
    createInMemoryCarbonEvidenceRepository(),
    createInMemoryCarbonEstimateRepository(),
    ledger,
    new H3Service(),
    events,
    ndvi,
    chaptersStub as never
  );
  return { service, ledger };
}

/** Group with two members and an open cycle — the standard fixture. */
async function makeGroupWithCycle(service: VslaCarbonService) {
  const group = await service.createGroup(lead, { name: 'Kano Women Savings' });
  const member2 = await service.addMember(lead, group.id, { userId: farmer.id });
  const leadMember = (await service.listMembers(group.id)).find((m) => m.userId === lead.id);
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
    const members = await service.listMembers(group.id);
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
    expect(await service.listMembers(group.id)).toHaveLength(2);
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
    expect(await service.listContributions(cycle.id)).toHaveLength(1);
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
    await contributeBoth(service, cycle.id, (await service.listMembers(group.id)).find((m) => m.userId === lead.id)!.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 1_000
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
        interestRateBps: 500
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
        interestRateBps: 0
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
      interestRateBps: 1_000
    });
    const first = await service.repayLoan(farmer, loan.id, {
      amountKobo: 50_000,
      idempotencyKey: 'r1'
    });
    expect(first.loan.repaidKobo).toBe(50_000);
    expect(first.loan.status).toBe('ACTIVE');
    const second = await service.repayLoan(farmer, loan.id, {
      amountKobo: 999_999, // overpay clamps to outstanding
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
      interestRateBps: 0
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
    expect(await service.listRepayments(loan.id)).toHaveLength(1);
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
      interestRateBps: 0
    });
    await expect(
      service.repayLoan(farmer2, loan.id, { amountKobo: 1_000, idempotencyKey: 'z1' })
    ).rejects.toThrow(ForbiddenException);
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

  it('leaves residual liability when a loan is outstanding against the pool', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 0
    });
    const report = await service.closeCycle(lead, cycle.id);
    expect(report.distributableKobo).toBe(300_000);
    const farmerPayout = report.payouts.find((p) => p.memberId === member2.id);
    const leadPayout = report.payouts.find((p) => p.memberId === leadMember.id);
    expect(farmerPayout?.shareKobo).toBe(225_000);
    expect(farmerPayout?.residualKobo).toBe(75_000);
    expect(leadPayout?.shareKobo).toBe(75_000);
    expect(leadPayout?.residualKobo).toBe(25_000);
    // Residual stays visible on the member liability account (deferred share).
    const liability = await ledger.balance(memberSavingsAccountCode(group.id, farmer.id));
    expect(liability.creditsKobo - liability.debitsKobo).toBe(75_000);
  });

  it('distributes an interest surplus pro-rata and zeroes interest income', async () => {
    const { service, ledger } = makeService();
    const { group, cycle, leadMember, member2 } = await makeGroupWithCycle(service);
    await contributeBoth(service, cycle.id, leadMember.id, member2.id);
    const loan = await service.issueLoan(lead, group.id, {
      memberId: member2.id,
      principalKobo: 100_000,
      interestRateBps: 1_000
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
    expect(await service.getShareOut(cycle.id)).toHaveLength(2);
  });

  it('requires a group admin to close a cycle', async () => {
    const { service } = makeService();
    const { cycle } = await makeGroupWithCycle(service);
    await expect(service.closeCycle(farmer, cycle.id)).rejects.toThrow(ForbiddenException);
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
    expect(await service.listEvidence(plot.id)).toHaveLength(1);
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
    expect(await service.listEvidence(plot.id)).toHaveLength(0);
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
    expect(await service.listEstimates(plot.id)).toHaveLength(1);
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
