import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Chapter,
  ChapterEvent,
  CreditGroup,
  CreditGroupMember,
  CreditLoanApplication,
  CreditRepayment,
  EscrowRecord,
  FarmPlot,
  Order,
  Profile
} from '@agric-platform/shared';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { InMemoryChapterRepository } from '../../database/repositories/chapter.repository.js';
import { InMemoryChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import {
  createInMemoryCoopScoreRepository,
  InMemoryCoopScoreRepository
} from '../../database/repositories/coop-score.repository.js';
import {
  InMemoryCreditGroupMemberRepository,
  InMemoryCreditGroupRepository,
  InMemoryCreditLoanRepository,
  InMemoryCreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import {
  InMemoryEscrowRepository,
  type EscrowRepository
} from '../../database/repositories/escrow.repository.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import {
  InMemoryVslaCycleRepository,
  InMemoryVslaGroupRepository,
  InMemoryVslaMemberRepository,
  InMemoryVslaShareOutPlanRepository,
  InMemoryVslaShareOutRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { CoopScoreService, type CoopScoreActor } from './coop-score.service.js';

/**
 * CoopScoreService orchestration tests (stage-27 Innovation 14). In-memory
 * repositories throughout; the deterministic factor math itself is pinned by
 * known-answer vectors in coop-score.spec.ts — here we pin assembly,
 * authorisation parity across roles, append-only versioning, idempotent
 * recompute, band-change events and fail-closed degradation.
 */

const COOP = 'chapter-coop-1';
const LEAD = 'user-lead-1';
const DAY_MS = 86_400_000;

const admin: CoopScoreActor = { id: 'user-admin', roles: ['admin'] };
const lender: CoopScoreActor = { id: 'user-lender', roles: ['lender'] };
const coopLead: CoopScoreActor = { id: LEAD, roles: ['chapter_lead'] };
const farmer: CoopScoreActor = { id: 'user-u9', roles: ['farmer'] };

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function chapter(): Chapter {
  return {
    id: COOP,
    name: 'Test Cooperative',
    level: 'ward',
    state: 'Kano',
    leadUserId: LEAD,
    memberCount: 4,
    active: true
  };
}

function meetings(count: number): ChapterEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${index}`,
    chapterId: COOP,
    title: `Meeting ${index}`,
    type: 'meeting' as const,
    startsAt: daysAgo(10 + index * 20),
    location: 'Kano',
    rsvpCount: 10,
    attendanceCount: 10
  }));
}

function loan(id: string, applicantUserId: string): CreditLoanApplication {
  return {
    id,
    applicantUserId,
    productId: 'product-1',
    principalKobo: 10_000,
    status: 'repaying',
    createdAt: daysAgo(90),
    updatedAt: daysAgo(90)
  };
}

function onTimeInstallment(id: string, loanId: string, amountKobo = 10_000): CreditRepayment {
  return {
    id,
    loanId,
    sequence: 1,
    dueAt: daysAgo(30),
    amountKobo,
    paidAt: daysAgo(31),
    paidAmountKobo: amountKobo,
    status: 'paid'
  };
}

function profile(userId: string, completionScore: number): Profile {
  return {
    userId,
    location: { state: 'Kano', lga: 'Kano Municipal' },
    farmingInterests: [],
    valueChains: [],
    completionScore,
    badges: []
  } as Profile;
}

function plot(id: string, ownerUserId: string): FarmPlot {
  return {
    id,
    ownerUserId,
    name: 'Plot',
    state: 'Kano',
    lga: 'Kano Municipal',
    centroidLat: 12,
    centroidLong: 8.5,
    sizeHectares: 1.5,
    createdAt: daysAgo(200),
    updatedAt: daysAgo(5),
    version: 1
  };
}

function saleOrder(id: string, sellerId: string): Order {
  return {
    id,
    listingId: `listing-${id}`,
    buyerId: 'buyer-1',
    sellerId,
    quantity: 1,
    totalNaira: 5000,
    status: 'completed',
    escrowRequired: true,
    createdAt: daysAgo(40)
  };
}

function escrow(id: string, orderId: string, status: EscrowRecord['status']): EscrowRecord {
  return { id, orderId, amountKobo: 500_000, status, heldAt: daysAgo(40), resolvedAt: daysAgo(20) };
}

interface Harness {
  service: CoopScoreService;
  scores: InMemoryCoopScoreRepository;
  escrows: InMemoryEscrowRepository;
  repayments: InMemoryCreditRepaymentRepository;
  loans: InMemoryCreditLoanRepository;
  published: DomainEvent[];
}

/** A "thriving" cooperative: every factor measured, near-perfect inputs. */
function buildHarness(overrides: { escrows?: EscrowRepository } = {}): Harness {
  const chapters = new InMemoryChapterRepository([chapter()]);
  const chapterEvents = new InMemoryChapterEventRepository(meetings(6));

  const creditGroups = new InMemoryCreditGroupRepository([
    { id: 'cgroup-1', name: 'Group', chapterId: COOP, createdBy: LEAD, createdAt: daysAgo(300) } as CreditGroup
  ]);
  const creditMembers: CreditGroupMember[] = ['user-u1', 'user-u2', 'user-u3'].map((userId) => ({
    groupId: 'cgroup-1',
    userId,
    role: 'member',
    joinedAt: daysAgo(300)
  }));
  const creditGroupMembers = new InMemoryCreditGroupMemberRepository(creditMembers);

  const loans = new InMemoryCreditLoanRepository([
    loan('loan-1', 'user-u1'),
    loan('loan-2', 'user-u2'),
    loan('loan-3', 'user-u3')
  ]);
  const repayments = new InMemoryCreditRepaymentRepository([
    onTimeInstallment('rep-1', 'loan-1'),
    onTimeInstallment('rep-2', 'loan-2'),
    onTimeInstallment('rep-3', 'loan-3')
  ]);

  const vslaGroups = new InMemoryVslaGroupRepository();
  void vslaGroups.create({
    id: 'vgroup-1',
    name: 'VSLA',
    chapterId: COOP,
    leadUserId: LEAD,
    status: 'ACTIVE',
    savingsAccountCode: 'vsla:vgroup-1:cash',
    loansReceivableAccountCode: 'vsla:vgroup-1:loans_receivable',
    interestIncomeAccountCode: 'vsla:vgroup-1:interest_income',
    createdAt: daysAgo(400),
    updatedAt: daysAgo(10)
  });
  const vslaMembers = new InMemoryVslaMemberRepository();
  for (const userId of ['user-u1', 'user-u2', 'user-u3', 'user-u4']) {
    void vslaMembers.create({
      id: `vm-${userId}`,
      groupId: 'vgroup-1',
      userId,
      role: 'member',
      status: 'ACTIVE',
      joinedAt: daysAgo(400)
    });
  }
  const vslaCycles = new InMemoryVslaCycleRepository();
  const shareOutPlans = new InMemoryVslaShareOutPlanRepository();
  const shareOuts = new InMemoryVslaShareOutRepository();
  for (const cycleIndex of [1, 2]) {
    const cycleId = `cycle-${cycleIndex}`;
    void vslaCycles.create({
      id: cycleId,
      groupId: 'vgroup-1',
      label: `Cycle ${cycleIndex}`,
      status: 'CLOSED',
      openedAt: daysAgo(400 - cycleIndex * 180),
      closedAt: daysAgo(220 - cycleIndex * 180),
      createdAt: daysAgo(400 - cycleIndex * 180)
    });
    for (const memberId of ['vm-user-u1', 'vm-user-u2']) {
      void shareOutPlans.create({
        id: `plan-${cycleId}-${memberId}`,
        cycleId,
        memberId,
        shareKobo: 100_000,
        contributedKobo: 90_000,
        residualKobo: 0,
        createdAt: daysAgo(200)
      });
      void shareOuts.create({
        id: `so-${cycleId}-${memberId}`,
        cycleId,
        memberId,
        shareKobo: 100_000,
        contributedKobo: 90_000,
        residualKobo: 0,
        ledgerEntryId: `le-${cycleId}-${memberId}`,
        createdAt: daysAgo(200)
      });
    }
  }

  const orders = new InMemoryOrderRepository([
    saleOrder('order-1', 'user-u1'),
    saleOrder('order-2', 'user-u1'),
    saleOrder('order-3', 'user-u2'),
    saleOrder('order-4', 'user-u3'),
    saleOrder('order-5', 'user-u3')
  ]);
  const escrows =
    overrides.escrows ??
    new InMemoryEscrowRepository([
      escrow('esc-1', 'order-1', 'released'),
      escrow('esc-2', 'order-2', 'released'),
      escrow('esc-3', 'order-3', 'released'),
      escrow('esc-4', 'order-4', 'released'),
      escrow('esc-5', 'order-5', 'released')
    ]);

  const profiles = new InMemoryProfileRepository([
    profile('user-u1', 80),
    profile('user-u2', 80),
    profile('user-u3', 80)
  ]);
  const plots = createInMemoryFarmPlotRepository([
    plot('plot-1', 'user-u1'),
    plot('plot-2', 'user-u2'),
    plot('plot-3', 'user-u3'),
    plot('plot-4', 'user-u4')
  ]);

  const scores = createInMemoryCoopScoreRepository();
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const published: DomainEvent[] = [];
  events.on('*', (event) => published.push(event));

  const service = new CoopScoreService(
    chapters,
    chapterEvents,
    creditGroups,
    creditGroupMembers,
    loans,
    repayments,
    vslaGroups,
    vslaMembers,
    vslaCycles,
    shareOuts,
    shareOutPlans,
    orders,
    escrows,
    profiles,
    plots,
    scores,
    events
  );
  return { service, scores, escrows: escrows as InMemoryEscrowRepository, repayments, loans, published };
}

/** Expected composite for the thriving harness (hand-computed). */
function expectedThrivingScore(): number {
  // repayment: 3 loans, all on time → 300 (measured)
  // vsla: 2/2 cycles closed, 4/4 share-outs paid → 200 (measured)
  // governance: 6 meetings/180d → cadence 75; attendance 60/60 → 75 → 150
  // commercial: 5 released → 200 (measured)
  // data: 4 members, 3 complete profiles, 4 plots → round(150*7/8) = 131
  return 300 + 200 + 150 + 200 + 131;
}

describe('CoopScoreService scoring + role visibility', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('computes the hand-verified composite on first read and persists version 1', async () => {
    const view = await harness.service.getCoopScore(COOP, admin);
    expect(view.score).toBe(expectedThrivingScore());
    expect(view.band).toBe('A');
    expect(view.version).toBe(1);
    expect(view.factors).toHaveLength(5);
    expect(view.factors.every((factor) => factor.basis === 'measured')).toBe(true);
  });

  it('admin, lender and the cooperative lead see the SAME number and payload', async () => {
    const asAdmin = await harness.service.getCoopScore(COOP, admin);
    const asLender = await harness.service.getCoopScore(COOP, lender);
    const asLead = await harness.service.getCoopScore(COOP, coopLead);
    expect(asLender).toEqual(asAdmin);
    expect(asLead).toEqual(asAdmin);
  });

  it('rejects members with no reviewer or leadership role', async () => {
    await expect(harness.service.getCoopScore(COOP, farmer)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(harness.service.recompute(COOP, farmer)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('404s for an unknown cooperative', async () => {
    await expect(harness.service.getCoopScore('chapter-missing', admin)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('partner read returns the identical payload (and 404 before any compute)', async () => {
    const fresh = buildHarness();
    await expect(fresh.service.getCoopScoreForPartner(COOP)).rejects.toBeInstanceOf(
      NotFoundException
    );
    const inApp = await harness.service.getCoopScore(COOP, admin);
    const partner = await harness.service.getCoopScoreForPartner(COOP);
    expect(partner).toEqual(inApp);
  });
});

describe('CoopScoreService append-only + idempotent recompute', () => {
  it('recompute with identical inputs appends nothing (same version, no new event)', async () => {
    const harness = buildHarness();
    const first = await harness.service.recompute(COOP, admin);
    expect(first.recomputed).toBe(true);
    expect(first.version).toBe(1);

    const second = await harness.service.recompute(COOP, lender);
    expect(second.recomputed).toBe(false);
    expect(second.version).toBe(1);
    expect(second.id).toBe(first.id);

    const history = await harness.scores.historyFor(COOP);
    expect(history).toHaveLength(1);
    const computedEvents = harness.published.filter(
      (event) => event.name === 'credit.coop_score.computed'
    );
    expect(computedEvents).toHaveLength(1);
  });

  it('changed inputs append a NEW version and emit band_changed on transition', async () => {
    const harness = buildHarness();
    const first = await harness.service.recompute(COOP, admin);
    expect(first.band).toBe('A');

    // Degrade: member loans default (missed installments) and escrows turn disputed.
    await harness.loans.create(loan('loan-4', 'user-u1'));
    for (let index = 0; index < 9; index += 1) {
      await harness.repayments.create({
        id: `missed-${index}`,
        loanId: 'loan-4',
        sequence: index + 1,
        dueAt: daysAgo(60),
        amountKobo: 100_000,
        status: 'missed'
      });
    }
    for (const id of ['esc-1', 'esc-2', 'esc-3', 'esc-4', 'esc-5']) {
      await harness.escrows.update(id, { status: 'disputed' });
    }

    const second = await harness.service.recompute(COOP, admin);
    expect(second.recomputed).toBe(true);
    expect(second.version).toBe(2);
    expect(second.score).toBeLessThan(first.score);
    expect(second.band).not.toBe('A');

    const history = await harness.scores.historyFor(COOP);
    expect(history.map((row) => row.version)).toEqual([2, 1]);

    const bandEvents = harness.published.filter(
      (event) => event.name === 'credit.coop_score.band_changed'
    );
    expect(bandEvents).toHaveLength(1);
    expect(bandEvents[0]!.payload).toMatchObject({
      cooperativeId: COOP,
      fromBand: 'A',
      toBand: second.band,
      version: 2
    });
  });
});

describe('CoopScoreService fail-closed degradation', () => {
  it('an unreadable source module degrades its factor to UNAVAILABLE with badge', async () => {
    const throwingEscrows: EscrowRepository = {
      find: () => Promise.reject(new Error('marketplace read model down'))
    } as unknown as EscrowRepository;
    const harness = buildHarness({ escrows: throwingEscrows });

    const view = await harness.service.getCoopScore(COOP, admin);
    const commercial = view.factors.find((factor) => factor.key === 'commercialReliability')!;
    expect(commercial.basis).toBe('unavailable');
    expect(commercial.points).toBe(0);
    // The other factors still score; nothing was interpolated.
    expect(view.score).toBe(expectedThrivingScore() - 200);
  });

  it('a cooperative with no data anywhere scores 0 (band D), all badges honest', async () => {
    const chapters = new InMemoryChapterRepository([chapter()]);
    const empty = new CoopScoreService(
      chapters,
      new InMemoryChapterEventRepository([]),
      new InMemoryCreditGroupRepository([]),
      new InMemoryCreditGroupMemberRepository([]),
      new InMemoryCreditLoanRepository([]),
      new InMemoryCreditRepaymentRepository([]),
      new InMemoryVslaGroupRepository(),
      new InMemoryVslaMemberRepository(),
      new InMemoryVslaCycleRepository(),
      new InMemoryVslaShareOutRepository(),
      new InMemoryVslaShareOutPlanRepository(),
      new InMemoryOrderRepository([]),
      new InMemoryEscrowRepository([]),
      new InMemoryProfileRepository([]),
      createInMemoryFarmPlotRepository([]),
      createInMemoryCoopScoreRepository(),
      new DomainEventsService(createInMemoryOutboxRepository())
    );
    const view = await empty.getCoopScore(COOP, admin);
    expect(view.score).toBe(0);
    expect(view.band).toBe('D');
    expect(view.factors.every((factor) => factor.basis !== 'measured')).toBe(true);
  });
});
