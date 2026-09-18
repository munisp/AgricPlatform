/**
 * FP-2 authorisation-scoping 403 matrix (audit fixes V-13, V-14, V-17, V-61).
 *
 * Service/controller-level matrix over in-memory repositories:
 *   V-13  VSLA-Carbon BOLA — every group-scoped read requires an ACTIVE
 *         member, a regulator or an admin; GET /plots is own-plots-only
 *         unless privileged.
 *   V-14  chapter_lead is scoped to their OWN chapter (roster, attendance,
 *         QR codes, announcements, map).
 *   V-17  voice sessions for unregistered phones are bound to their creator
 *         (owner-or-agent); the dictated NIN ref persists only as a salted
 *         HMAC, never plaintext.
 *   V-61  privileged-role horizontal reads: lender score previews need an
 *         application linkage; donors read only programmes they fund;
 *         webinar rosters are host-bound.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { AuditService } from '../src/core/audit.service.js';
import { DomainEventsService } from '../src/core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../src/database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../src/database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../src/database/repositories/user.repository.js';
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
  createInMemoryVslaShareOutPlanRepository,
  createInMemoryVslaShareOutRepository
} from '../src/database/repositories/vsla-carbon.repository.js';
import { createInMemoryAnnouncementRepository } from '../src/database/repositories/announcement.repository.js';
import { createInMemoryChapterEventRepository } from '../src/database/repositories/chapter-event.repository.js';
import { createInMemoryChapterRepository } from '../src/database/repositories/chapter.repository.js';
import { createInMemoryEventRsvpRepository } from '../src/database/repositories/event-rsvp.repository.js';
import {
  createInMemoryAgentCaseRepository,
  createInMemoryVoiceSessionRepository,
  createInMemoryVoiceTurnRepository
} from '../src/database/repositories/voice.repository.js';
import {
  createInMemoryCreditCollateralRepository,
  createInMemoryCreditGroupMemberRepository,
  createInMemoryCreditGroupRepository,
  createInMemoryCreditRestructureRepository,
  createInMemoryCreditGuarantorRepository,
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditSavingsAccountRepository,
  createInMemoryCreditSavingsTransactionRepository,
  InMemoryCreditProductRepository
} from '../src/database/repositories/credit-suite.repository.js';
import { InMemoryOrderRepository } from '../src/database/repositories/order.repository.js';
import { InMemoryProfileRepository } from '../src/database/repositories/profile.repository.js';
import {
  createInMemoryBeneficiaryRepository,
  createInMemoryInputVoucherRepository,
  createInMemoryProgrammeFundingRepository,
  createInMemoryRedemptionRepository,
  createInMemorySubsidyProgrammeRepository
} from '../src/database/repositories/input-vouchers.repository.js';
import {
  createInMemoryKnowledgeResourceRepository,
  createInMemoryPodcastEpisodeRepository
} from '../src/database/repositories/knowledge.repository.js';
import {
  createInMemoryWebinarRegistrationRepository,
  createInMemoryWebinarRepository
} from '../src/database/repositories/webinar.repository.js';
import { LedgerService } from '../src/modules/finance/ledger.service.js';
import { H3Service } from '../src/modules/geo/h3.service.js';
import { VslaCarbonService } from '../src/modules/vsla-carbon/vsla-carbon.service.js';
import type { NdviProvider } from '../src/modules/vsla-carbon/ndvi.provider.js';
import { ChaptersService } from '../src/modules/chapters/chapters.service.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { AgronomyRagService, type AgronomyCorpus } from '../src/modules/voice/agronomy-rag.service.js';
import { VoiceService } from '../src/modules/voice/voice.service.js';
import { CreditService } from '../src/modules/credit/credit.service.js';
import { InputVouchersService } from '../src/modules/input-vouchers/input-vouchers.service.js';
import { StubIdentityDriver } from '../src/modules/input-vouchers/identity.driver.js';
import { KnowledgeService } from '../src/modules/knowledge/knowledge.service.js';
import { KnowledgeController } from '../src/modules/knowledge/knowledge.controller.js';

const lead = { id: 'user-lead', roles: ['chapter_lead'] } as unknown as User;
const member = { id: 'user-member', roles: ['farmer'] } as unknown as User;
const outsider = { id: 'user-outsider', roles: ['farmer'] } as unknown as User;
const admin = { id: 'user-admin', roles: ['admin'] } as unknown as User;
const regulator = { id: 'user-regulator', roles: ['regulator'] } as unknown as User;
const donor = { id: 'user-donor', roles: ['donor'] } as unknown as User;

/* ------------------------------------------------------------------ V-13 */

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

async function makeVslaFixture() {
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
    createInMemoryVslaShareOutPlanRepository(),
    createInMemoryVslaLoanRepository(),
    createInMemoryVslaLoanRepaymentRepository(),
    createInMemoryCarbonPlotRepository(),
    createInMemoryCarbonEvidenceRepository(),
    createInMemoryCarbonEstimateRepository(),
    ledger,
    new H3Service(),
    events,
    stubNdvi
  );
  const group = await service.createGroup(lead, { name: 'Authz VSLA' });
  const memberRow = await service.addMember(lead, group.id, { userId: member.id });
  const leadMember = (await service.listMembers(admin, group.id)).find(
    (row) => row.userId === lead.id
  )!;
  const cycle = await service.openCycle(lead, group.id, '2026 Cycle 1');
  await service.contribute(lead, cycle.id, {
    memberId: leadMember.id,
    amountKobo: 300_000,
    idempotencyKey: 'c-lead'
  });
  await service.contribute(member, cycle.id, {
    memberId: memberRow.id,
    amountKobo: 100_000,
    idempotencyKey: 'c-member'
  });
  const loan = await service.issueLoan(lead, group.id, {
    memberId: memberRow.id,
    principalKobo: 100_000,
    interestRateBps: 1_000,
    idempotencyKey: 'issue-1'
  });
  const plot = await service.registerPlot(member, {
    groupId: group.id,
    name: 'Member plot',
    practiceType: 'agroforestry',
    hectares: 1.5,
    centroidLat: 9.05,
    centroidLong: 7.49
  });
  return { service, group, cycle, loan, plot };
}

describe('V-13: VSLA-Carbon reads are membership-scoped', () => {
  it('403s a non-member on EVERY group-scoped read route', async () => {
    const { service, group, cycle, loan, plot } = await makeVslaFixture();
    const reads: Array<() => Promise<unknown>> = [
      () => service.readGroup(outsider, group.id),
      () => service.listMembers(outsider, group.id),
      () => service.listCycles(outsider, group.id),
      () => service.listLoans(outsider, group.id),
      () => service.listContributions(outsider, cycle.id),
      () => service.getShareOut(outsider, cycle.id),
      () => service.listRepayments(outsider, loan.id),
      () => service.readPlot(outsider, plot.id),
      () => service.listEvidence(outsider, plot.id),
      () => service.listEstimates(outsider, plot.id),
      () => service.listPlots(outsider, group.id)
    ];
    for (const read of reads) {
      await expect(read()).rejects.toBeInstanceOf(ForbiddenException);
    }
    // Donors are NOT privileged readers of group internals (listGroups stays
    // the only donor-visible aggregate surface).
    await expect(service.readGroup(donor, group.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('member reads own group records; admin and regulator read all', async () => {
    const { service, group, cycle, loan, plot } = await makeVslaFixture();
    await expect(service.readGroup(member, group.id)).resolves.toMatchObject({ id: group.id });
    await expect(service.listMembers(member, group.id)).resolves.toHaveLength(2);
    await expect(service.listContributions(member, cycle.id)).resolves.toHaveLength(2);
    await expect(service.listRepayments(member, loan.id)).resolves.toHaveLength(0);
    await expect(service.readPlot(member, plot.id)).resolves.toMatchObject({ id: plot.id });
    await expect(service.readGroup(admin, group.id)).resolves.toMatchObject({ id: group.id });
    await expect(service.listLoans(admin, group.id)).resolves.toHaveLength(1);
    await expect(service.readGroup(regulator, group.id)).resolves.toMatchObject({ id: group.id });
    await expect(service.listCycles(regulator, group.id)).resolves.toHaveLength(1);
    await expect(service.listEstimates(regulator, plot.id)).resolves.toHaveLength(0);
  });

  it('scopes GET /plots to own plots unless privileged', async () => {
    const { service, group, plot } = await makeVslaFixture();
    // The owning member sees their plot; another member of the group does not.
    await expect(service.listPlots(member)).resolves.toHaveLength(1);
    await expect(service.listPlots(member, group.id)).resolves.toHaveLength(1);
    await expect(service.listPlots(lead, group.id)).resolves.toHaveLength(0);
    // A non-member without a group filter simply sees their own (empty) set.
    await expect(service.listPlots(outsider)).resolves.toHaveLength(0);
    // Privileged readers see everything.
    await expect(service.listPlots(admin)).resolves.toHaveLength(1);
    await expect(service.listPlots(regulator, group.id)).resolves.toHaveLength(1);
    expect((await service.listPlots(admin))[0].id).toBe(plot.id);
  });
});

/* ------------------------------------------------------------------ V-14 */

function makeChaptersService() {
  const events = createInMemoryChapterEventRepository();
  return new ChaptersService(
    new DomainEventsService(createInMemoryOutboxRepository()),
    createInMemoryChapterRepository(),
    events,
    createInMemoryEventRsvpRepository(events),
    createInMemoryAnnouncementRepository()
  );
}

describe('V-14: chapter leads are scoped to their own chapter', () => {
  it('lead of chapter A is 403 on chapter B; own chapter and admin pass', async () => {
    const chapters = makeChaptersService();
    const leadA = { id: 'user-lead-a', roles: ['chapter_lead'] } as unknown as User;
    const leadB = { id: 'user-lead-b', roles: ['chapter_lead'] } as unknown as User;
    const chapterA = await chapters.create({
      name: 'Kano Ward',
      level: 'ward',
      state: 'Kano',
      leadUserId: leadA.id
    });
    const chapterB = await chapters.create({
      name: 'Zaria Ward',
      level: 'ward',
      state: 'Kaduna',
      leadUserId: leadB.id
    });
    // Cross-chapter: 403 (roster/attendance/QR/announcement/event guards all
    // funnel through assertChapterLeadOrAdmin on the event's chapterId).
    await expect(chapters.assertChapterLeadOrAdmin(leadA, chapterB.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(chapters.assertChapterLeadOrAdmin(leadB, chapterA.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    // Own chapter + admin: pass.
    await expect(chapters.assertChapterLeadOrAdmin(leadA, chapterA.id)).resolves.toBeUndefined();
    await expect(chapters.assertChapterLeadOrAdmin(admin, chapterB.id)).resolves.toBeUndefined();
    // Non-lead roles and anonymous callers fail too.
    await expect(chapters.assertChapterLeadOrAdmin(outsider, chapterA.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(chapters.assertChapterLeadOrAdmin(null, chapterA.id)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});

/* ------------------------------------------------------------------ V-17 */

function makeVoiceService() {
  const users = new UsersService(createInMemoryUserRepository());
  const events = { publish: vi.fn().mockResolvedValue({}) } as unknown as DomainEventsService;
  const audit = { record: vi.fn().mockResolvedValue({}) } as unknown as AuditService;
  const sessions = createInMemoryVoiceSessionRepository();
  const corpus: AgronomyCorpus = { listChunks: async () => [] };
  const service = new VoiceService(
    users,
    events,
    audit,
    sessions,
    createInMemoryVoiceTurnRepository(),
    createInMemoryAgentCaseRepository(),
    new AgronomyRagService(corpus),
    null,
    {} as NodeJS.ProcessEnv
  );
  return { service, sessions };
}

describe('V-17: unidentified voice sessions are owner-or-agent; ninRef hashed at rest', () => {
  it('non-creator is 403 on an unidentified session; creator and agent pass', async () => {
    const { service } = makeVoiceService();
    const agent = { id: 'user-agent', roles: ['agronomist'] } as unknown as User;
    const { session } = await service.startSession(member, {
      channel: 'ivr',
      phone: '+2348077777777' // not in the farmer directory → unidentified
    });
    expect(session.farmerUserId).toBeUndefined();
    expect(session.createdByUserId).toBe(member.id);

    await expect(service.getSessionTranscript(outsider, session.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(
      service.handleTurn(outsider, session.id, { text: 'hello' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.escalate(outsider, session.id)).rejects.toBeInstanceOf(ForbiddenException);

    await expect(service.getSessionTranscript(member, session.id)).resolves.toMatchObject({
      session: { id: session.id }
    });
    await expect(service.getSessionTranscript(agent, session.id)).resolves.toMatchObject({
      session: { id: session.id }
    });
    await expect(service.getSessionTranscript(admin, session.id)).resolves.toMatchObject({
      session: { id: session.id }
    });
  });

  it('persists the dictated NIN ref only as a salted HMAC — never plaintext', async () => {
    const { service, sessions } = makeVoiceService();
    const { session } = await service.startSession(member, {
      channel: 'ivr',
      phone: '+2348077777777',
      ninRef: 'NIN-1234'
    });
    const stored = await sessions.findById(session.id);
    expect(stored?.ninRef).toBeUndefined();
    expect(stored?.ninRefHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.ninRefHash).not.toContain('NIN-1234');
  });
});

/* ------------------------------------------------------------------ V-61 */

const CREDIT_PRODUCT = {
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

function makeCreditService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const transactions = createInMemoryCreditSavingsTransactionRepository();
  return new CreditService(
    events,
    new InMemoryCreditProductRepository([CREDIT_PRODUCT]),
    createInMemoryCreditLoanRepository(),
    createInMemoryCreditRepaymentRepository(),
    createInMemoryCreditCollateralRepository(),
    createInMemoryCreditGuarantorRepository(),
    createInMemoryCreditGroupRepository(),
    createInMemoryCreditGroupMemberRepository(),
    createInMemoryCreditSavingsAccountRepository(transactions),
    new InMemoryProfileRepository(),
    new InMemoryOrderRepository(),
    createInMemoryCreditRestructureRepository(),
    transactions
  );
}

describe('V-61: lender score previews require an application linkage', () => {
  const lender = { id: 'user-lender', roles: ['lender'] };
  const lenderTwo = { id: 'user-lender-2', roles: ['lender'] };

  it('lender without any linkage is 403; self and admin pass', async () => {
    const credit = makeCreditService();
    await expect(credit.assertScoreReadAccess(lender, member.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(credit.assertScoreReadAccess(member, member.id)).resolves.toBeUndefined();
    await expect(credit.assertScoreReadAccess(admin, member.id)).resolves.toBeUndefined();
  });

  it('an active application opens the preview; after rejection only the deciding lender keeps it', async () => {
    const credit = makeCreditService();
    const draft = await credit.apply(
      { productId: CREDIT_PRODUCT.id, principalKobo: 500_000, purpose: 'Seed' },
      member
    );
    await credit.submit(draft.id, member);
    // Active pipeline application → a reviewing lender passes.
    await expect(credit.assertScoreReadAccess(lender, member.id)).resolves.toBeUndefined();
    // Terminal outcome: only the lender who DECIDED retains the linkage.
    await credit.score(draft.id, lender);
    await credit.reject(draft.id, lender);
    await expect(credit.assertScoreReadAccess(lender, member.id)).resolves.toBeUndefined();
    await expect(credit.assertScoreReadAccess(lenderTwo, member.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

async function makeVouchersService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const service = new InputVouchersService(
    createInMemorySubsidyProgrammeRepository(),
    createInMemoryBeneficiaryRepository(),
    createInMemoryInputVoucherRepository(),
    createInMemoryRedemptionRepository(),
    createInMemoryProgrammeFundingRepository(),
    ledger,
    new UsersService(createInMemoryUserRepository()),
    events,
    new StubIdentityDriver(),
    undefined,
    {}
  );
  return service;
}

describe('V-61: donor voucher-programme reads are funder-bound', () => {
  it('donor of programme A is 403 on programme B; funder/regulator/admin pass', async () => {
    const vouchers = await makeVouchersService();
    const programmeA = await vouchers.createProgramme(
      {
        name: 'Fertiliser A',
        sponsor: 'Donor A',
        funderId: donor.id,
        perFarmerCapKobo: 50_000,
        budgetKobo: 5_000_000
      },
      admin.id
    );
    const programmeB = await vouchers.createProgramme(
      {
        name: 'Seed B',
        sponsor: 'Donor B',
        funderId: 'user-donor-b',
        perFarmerCapKobo: 50_000,
        budgetKobo: 5_000_000
      },
      admin.id
    );
    await expect(
      vouchers.assertProgrammeReadScope(donor, programmeB.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      vouchers.assertProgrammeReadScope(donor, programmeA.id)
    ).resolves.toBeUndefined();
    await expect(
      vouchers.assertProgrammeReadScope(regulator, programmeB.id)
    ).resolves.toBeUndefined();
    await expect(
      vouchers.assertProgrammeReadScope(admin, programmeB.id)
    ).resolves.toBeUndefined();
    // A programme with NO recorded funder (pre-082) fails closed for donors.
    const legacy = await vouchers.createProgramme(
      {
        name: 'Legacy',
        sponsor: 'Legacy sponsor',
        perFarmerCapKobo: 50_000,
        budgetKobo: 5_000_000
      },
      admin.id
    );
    await expect(
      vouchers.assertProgrammeReadScope(donor, legacy.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('V-61: webinar rosters are host-bound', () => {
  it('a partner is 403 on another partner\'s webinar roster; host and admin pass', async () => {
    const knowledge = new KnowledgeService(
      new DomainEventsService(createInMemoryOutboxRepository()),
      createInMemoryKnowledgeResourceRepository(),
      createInMemoryPodcastEpisodeRepository(),
      createInMemoryWebinarRepository(),
      createInMemoryWebinarRegistrationRepository()
    );
    const controller = new KnowledgeController(knowledge);
    const host = { id: 'user-partner-a', roles: ['partner'] } as unknown as User;
    const rival = { id: 'user-partner-b', roles: ['partner'] } as unknown as User;
    const webinar = await knowledge.createWebinar(
      { title: 'Agronomy AMA', hostUserId: host.id, startsAt: '2026-10-01T10:00:00.000Z' },
      host.id
    );
    await expect(controller.listRegistrations(webinar.id, rival)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(controller.listRegistrations(webinar.id, host)).resolves.toEqual({ data: [] });
    await expect(controller.listRegistrations(webinar.id, admin)).resolves.toEqual({ data: [] });
    await expect(controller.listRegistrations(webinar.id, null)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});
