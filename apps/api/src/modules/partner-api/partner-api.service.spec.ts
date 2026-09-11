import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentRecord } from '@agric-platform/shared';
import { createInMemoryWebhookSubscriptionRepository } from '../../database/repositories/partner-api.repository.js';
import {
  createInMemoryExternalAccountLinkRepository,
  createInMemoryFarmRecordRepository,
  createInMemoryInboundEventRepository,
  type ExternalAccountLink
} from '../../database/repositories/phase3.repository.js';
import {
  PARTNER_SHARE_CONSENT_PURPOSE,
  PartnerApiService
} from './partner-api.service.js';

function consent(userId: string, granted = true, revoked = false): ConsentRecord {
  return {
    id: `consent-${userId}`,
    userId,
    purpose: PARTNER_SHARE_CONSENT_PURPOSE,
    granted,
    source: 'test',
    grantedAt: new Date().toISOString(),
    revokedAt: revoked ? new Date().toISOString() : undefined
  };
}

function accountLink(userId: string, id = `link-${userId}`): ExternalAccountLink {
  return {
    id,
    userId,
    system: 'farmos',
    externalId: `ext-${userId}`,
    consentAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

interface TestApplication {
  id: string;
  userId: string;
  partnerId: string;
  status: string;
}

interface TestProgramme {
  id: string;
  partnerId?: string;
}

const DEFAULT_APPLICATIONS: TestApplication[] = [
  { id: 'app-1', userId: 'user-a', partnerId: 'partner-1', status: 'submitted' },
  { id: 'app-2', userId: 'user-b', partnerId: 'partner-1', status: 'successful' },
  { id: 'app-3', userId: 'user-a', partnerId: 'partner-1', status: 'successful' }
];

const DEFAULT_PROGRAMMES: TestProgramme[] = [
  { id: 'opp-1', partnerId: 'partner-1' },
  { id: 'opp-2', partnerId: 'partner-1' }
];

function makeService(
  options: {
    consents?: ConsentRecord[];
    links?: ExternalAccountLink[];
    applications?: TestApplication[];
    programmes?: TestProgramme[];
  } = {}
) {
  const applications = options.applications ?? DEFAULT_APPLICATIONS;
  const programmes = options.programmes ?? DEFAULT_PROGRAMMES;
  const opportunities = {
    applicationsForPartner: vi.fn(async (partnerId: string) =>
      applications.filter((application) => application.partnerId === partnerId)
    ),
    opportunitiesForPartner: vi.fn(async (partnerId: string) =>
      programmes.filter((programme) => programme.partnerId === partnerId)
    ),
    get: vi.fn(async (id: string) => {
      const programme = programmes.find((candidate) => candidate.id === id);
      if (!programme) {
        throw new NotFoundException(`Resource with id '${id}' not found`);
      }
      return programme;
    })
  };
  const learning = {
    enrolmentsForUser: vi.fn(async (userId: string) => [
      { id: `enr-${userId}`, status: userId === 'user-a' ? 'completed' : 'enrolled' }
    ])
  };
  const users = {
    findById: vi.fn(async (id: string) => ({ id, fullName: `Name ${id}` })),
    getById: vi.fn(async (id: string) => ({ id, fullName: `Name ${id}` }))
  };
  const profiles = {
    get: vi.fn(async (userId: string) => ({ userId, location: { state: 'Kano' } }))
  };
  const audit = { record: vi.fn(async () => ({})) };
  const events = { publish: vi.fn(async (name: string, payload: unknown) => ({ name, payload })) };
  const consentRepo = {
    find: vi.fn(async ({ userId }: { userId?: string }) =>
      (options.consents ?? []).filter((record) => !userId || record.userId === userId)
    )
  };
  const subscriptions = createInMemoryWebhookSubscriptionRepository();
  const accountLinks = createInMemoryExternalAccountLinkRepository(options.links ?? []);
  const farmRecords = createInMemoryFarmRecordRepository();
  const inboundEvents = createInMemoryInboundEventRepository();
  const service = new PartnerApiService(
    opportunities as never,
    learning as never,
    users as never,
    profiles as never,
    audit as never,
    events as never,
    consentRepo as never,
    subscriptions,
    accountLinks,
    farmRecords,
    inboundEvents
  );
  return { service, events, audit, subscriptions, accountLinks, farmRecords, inboundEvents };
}

describe('PartnerApiService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns only consented participants', async () => {
    const { service } = makeService({ consents: [consent('user-a')] });
    const participants = await service.consentedParticipation('partner-1');
    expect(participants.map((p) => p.userId)).toEqual(['user-a']);
    expect(participants[0].name).toBe('Name user-a');
    expect(participants[0].state).toBe('Kano');
  });

  it('treats revoked consent as no consent', async () => {
    const { service } = makeService({ consents: [consent('user-a', true, true)] });
    expect(await service.consentedParticipation('partner-1')).toEqual([]);
  });

  it('builds an aggregate impact report without PII', async () => {
    const { service } = makeService({ consents: [consent('user-a'), consent('user-b')] });
    const report = await service.impactAggregate('partner-1');
    expect(report).toMatchObject({
      partnerId: 'partner-1',
      programmes: 2,
      participants: 2,
      consentedParticipants: 2,
      applications: 3,
      completedTrainings: 1
    });
  });

  it('counts applications per partner', async () => {
    const { service } = makeService();
    expect(await service.applicationCount('partner-1')).toEqual({
      partnerId: 'partner-1',
      applications: 3
    });
  });

  it('denies member profile reads without consent (403)', async () => {
    const { service } = makeService();
    await expect(service.consentedMemberProfile('user-a')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('returns member profile with consent and audits the read', async () => {
    const { service, audit } = makeService({ consents: [consent('user-a')] });
    const result = await service.consentedMemberProfile('user-a');
    expect(result.user.id).toBe('user-a');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'partner.member_profile.read' })
    );
  });

  it('records disbursements and publishes the domain event', async () => {
    const { service, events } = makeService();
    const recorded = await service.recordDisbursement(
      'partner-1',
      { userId: 'user-a', amountNgn: 50_000, reference: 'ref-1' },
      'pc_test'
    );
    expect(recorded.amountNgn).toBe(50_000);
    expect(events.publish).toHaveBeenCalledWith(
      'partner.disbursement.recorded',
      expect.objectContaining({ userId: 'user-a' }),
      'pc_test'
    );
  });

  it('records enrolments against the partner programmes only', async () => {
    const { service, events } = makeService();
    await service.recordEnrolment(
      'partner-1',
      { userId: 'user-a', programmeId: 'opp-1' },
      'pc_test'
    );
    expect(events.publish).toHaveBeenCalledWith(
      'partner.enrolment.recorded',
      expect.objectContaining({ programmeId: 'opp-1' }),
      'pc_test'
    );
    await expect(
      service.recordEnrolment('partner-1', { userId: 'user-a', programmeId: 'opp-x' }, 'pc_test')
    ).rejects.toThrow();
  });

  it('persists farm-data pushes against the member external account link', async () => {
    const { service, events, farmRecords, inboundEvents } = makeService({
      links: [accountLink('user-a')]
    });
    const result = await service.recordFarmDataPush(
      'partner-1',
      'user-a',
      { assets: [{ type: 'asset--land', name: 'Plot 4' }] },
      'pc_test'
    );
    expect(result.linked).toBe(true);
    expect(result.pendingLink).toBeUndefined();
    const stored = await farmRecords.find({ linkId: 'link-user-a' });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: result.farmRecordId,
      recordType: 'partner_push',
      externalId: result.id,
      source: 'partner_api'
    });
    expect(stored[0].payload).toEqual({ assets: [{ type: 'asset--land', name: 'Plot 4' }] });
    // Pending ledger stays empty on the linked path; the domain event survives.
    expect(await inboundEvents.count({ system: 'partner_api' })).toBe(0);
    expect(events.publish).toHaveBeenCalledWith(
      'partner.farm_data.received',
      expect.objectContaining({ id: result.id, linked: true, assetCount: 1 }),
      'pc_test'
    );
  });

  it('ledgers farm-data pushes with a pending-link marker when unlinked', async () => {
    const { service, events, farmRecords, inboundEvents } = makeService();
    const result = await service.recordFarmDataPush(
      'partner-1',
      'user-b',
      { logs: [{ type: 'log--harvest' }] },
      'pc_test'
    );
    expect(result.linked).toBe(false);
    expect(result.pendingLink).toBe(true);
    expect(result.farmRecordId).toBeUndefined();
    expect(await farmRecords.count({})).toBe(0);
    const ledgered = await inboundEvents.find({ system: 'partner_api' });
    expect(ledgered).toHaveLength(1);
    expect(ledgered[0]).toMatchObject({
      eventType: 'farm_data.pending_link',
      dedupeKey: result.id
    });
    expect(ledgered[0].payload).toMatchObject({
      userId: 'user-b',
      linkId: 'pending-link:user-b',
      logs: [{ type: 'log--harvest' }]
    });
    expect(events.publish).toHaveBeenCalledWith(
      'partner.farm_data.received',
      expect.objectContaining({ id: result.id, pendingLink: true }),
      'pc_test'
    );
  });

  it('ignores revoked links and ledgers the push as pending-link', async () => {
    // user-b is in partner-1 scope via app-2; the revoked link exercises the
    // pending-link path (WP-G22 made out-of-scope subjects a 404 instead).
    const { service, farmRecords } = makeService({
      links: [{ ...accountLink('user-b'), revokedAt: new Date().toISOString() }]
    });
    const result = await service.recordFarmDataPush('partner-1', 'user-b', { assets: [] }, 'pc_test');
    expect(result.pendingLink).toBe(true);
    expect(await farmRecords.count({})).toBe(0);
  });

  describe('write-path tenant binding (Stage 27, WP-G22)', () => {
    it('records a disbursement against an own programme and audits actor/subject', async () => {
      const { service, audit } = makeService();
      const recorded = await service.recordDisbursement(
        'partner-1',
        { userId: 'user-a', amountNgn: 50_000, programmeId: 'opp-1' },
        'pc_test'
      );
      expect(recorded.programmeId).toBe('opp-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'pc_test',
          action: 'partner.disbursement.recorded',
          entityType: 'disbursement',
          entityId: recorded.id,
          metadata: { partnerId: 'partner-1', amountNgn: 50_000 }
        })
      );
    });

    it('accepts a disbursement against an unassigned (claimable) programme', async () => {
      const { service } = makeService({
        programmes: [...DEFAULT_PROGRAMMES, { id: 'opp-open' }]
      });
      const recorded = await service.recordDisbursement(
        'partner-1',
        { userId: 'user-a', amountNgn: 10_000, programmeId: 'opp-open' },
        'pc_test'
      );
      expect(recorded.programmeId).toBe('opp-open');
    });

    it("rejects a disbursement against another partner's programme, indistinguishable from nonexistent (404)", async () => {
      const { service, events } = makeService({
        programmes: [...DEFAULT_PROGRAMMES, { id: 'opp-foreign', partnerId: 'partner-2' }]
      });
      const foreign = await service
        .recordDisbursement(
          'partner-1',
          { userId: 'user-a', amountNgn: 10_000, programmeId: 'opp-foreign' },
          'pc_test'
        )
        .catch((error: unknown) => error);
      const nonexistent = await service
        .recordDisbursement(
          'partner-1',
          { userId: 'user-a', amountNgn: 10_000, programmeId: 'opp-ghost' },
          'pc_test'
        )
        .catch((error: unknown) => error);
      expect(foreign).toBeInstanceOf(NotFoundException);
      expect(nonexistent).toBeInstanceOf(NotFoundException);
      expect((foreign as NotFoundException).getStatus()).toBe(404);
      expect((foreign as NotFoundException).message).toBe(
        (nonexistent as NotFoundException).message.replace('opp-ghost', 'opp-foreign')
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('enrols an application-bound member and audits actor/subject', async () => {
      const { service, audit } = makeService();
      const recorded = await service.recordEnrolment(
        'partner-1',
        { userId: 'user-a', programmeId: 'opp-1' },
        'pc_test'
      );
      expect(recorded.userId).toBe('user-a');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'pc_test',
          action: 'partner.enrolment.recorded',
          entityType: 'partner_enrolment',
          entityId: recorded.id,
          metadata: { partnerId: 'partner-1', programmeId: 'opp-1' }
        })
      );
    });

    it('enrols a consent-bound member without an application (explicit consent record)', async () => {
      const { service, events } = makeService({ consents: [consent('user-c')] });
      const recorded = await service.recordEnrolment(
        'partner-1',
        { userId: 'user-c', programmeId: 'opp-1' },
        'pc_test'
      );
      expect(recorded.userId).toBe('user-c');
      expect(events.publish).toHaveBeenCalledWith(
        'partner.enrolment.recorded',
        expect.objectContaining({ userId: 'user-c' }),
        'pc_test'
      );
    });

    it('rejects enrolling a member outside the partner scope, indistinguishable from nonexistent (404)', async () => {
      const { service, events } = makeService();
      const unbound = await service
        .recordEnrolment('partner-1', { userId: 'user-c', programmeId: 'opp-1' }, 'pc_test')
        .catch((error: unknown) => error);
      const ghost = await service
        .recordEnrolment('partner-1', { userId: 'user-ghost', programmeId: 'opp-1' }, 'pc_test')
        .catch((error: unknown) => error);
      expect(unbound).toBeInstanceOf(NotFoundException);
      expect(ghost).toBeInstanceOf(NotFoundException);
      expect((unbound as NotFoundException).message).toBe(
        (ghost as NotFoundException).message.replace('user-ghost', 'user-c')
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('rejects a cross-partner enrolment programme, indistinguishable from nonexistent (404)', async () => {
      const { service } = makeService({
        programmes: [...DEFAULT_PROGRAMMES, { id: 'opp-foreign', partnerId: 'partner-2' }]
      });
      const foreign = await service
        .recordEnrolment('partner-1', { userId: 'user-a', programmeId: 'opp-foreign' }, 'pc_test')
        .catch((error: unknown) => error);
      const nonexistent = await service
        .recordEnrolment('partner-1', { userId: 'user-a', programmeId: 'opp-ghost' }, 'pc_test')
        .catch((error: unknown) => error);
      expect(foreign).toBeInstanceOf(NotFoundException);
      expect(nonexistent).toBeInstanceOf(NotFoundException);
      expect((foreign as NotFoundException).message).toBe(
        (nonexistent as NotFoundException).message.replace('opp-ghost', 'opp-foreign')
      );
    });

    it('accepts farm data for an application-bound subject and audits actor=client, subject=user', async () => {
      const { service, audit } = makeService({ links: [accountLink('user-a')] });
      const result = await service.recordFarmDataPush(
        'partner-1',
        'user-a',
        { assets: [] },
        'pc_test'
      );
      expect(result.linked).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'pc_test',
          action: 'partner.farm_data.received',
          entityType: 'user',
          entityId: 'user-a',
          metadata: { partnerId: 'partner-1', linked: true }
        })
      );
    });

    it('accepts farm data for a consent-bound subject without an application', async () => {
      const { service } = makeService({
        consents: [consent('user-c')],
        links: [accountLink('user-c')]
      });
      const result = await service.recordFarmDataPush(
        'partner-1',
        'user-c',
        { assets: [] },
        'pc_test'
      );
      expect(result.accepted).toBe(true);
      expect(result.linked).toBe(true);
    });

    it('rejects farm data for an out-of-scope subject, indistinguishable from nonexistent (404), with no side effects', async () => {
      const { service, events, audit, farmRecords, inboundEvents } = makeService();
      const crossPartner = await service
        .recordFarmDataPush('partner-2', 'user-a', { assets: [] }, 'pc_other')
        .catch((error: unknown) => error);
      const ghost = await service
        .recordFarmDataPush('partner-2', 'user-ghost', { assets: [] }, 'pc_other')
        .catch((error: unknown) => error);
      expect(crossPartner).toBeInstanceOf(NotFoundException);
      expect(ghost).toBeInstanceOf(NotFoundException);
      expect((crossPartner as NotFoundException).message).toBe(
        (ghost as NotFoundException).message.replace('user-ghost', 'user-a')
      );
      expect(events.publish).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(await farmRecords.count({})).toBe(0);
      expect(await inboundEvents.count({})).toBe(0);
    });
  });

  it('creates webhook subscriptions and never echoes secrets on list', async () => {
    const { service } = makeService();
    await service.createWebhookSubscription('pc_test', {
      eventTypes: ['disbursement.recorded'],
      targetUrl: 'https://partner.example/hook',
      secret: 'sixteen-char-secret'
    });
    const listed = await service.webhookSubscriptionsFor('pc_test');
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
  });

  it('rejects unknown webhook event types', async () => {
    const { service } = makeService();
    await expect(
      service.createWebhookSubscription('pc_test', {
        eventTypes: ['not.a.real.event'],
        targetUrl: 'https://partner.example/hook',
        secret: 'sixteen-char-secret'
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('only lets the owning client delete a subscription', async () => {
    const { service } = makeService();
    const created = await service.createWebhookSubscription('pc_test', {
      eventTypes: ['course.completed'],
      targetUrl: 'https://partner.example/hook',
      secret: 'sixteen-char-secret'
    });
    await expect(service.removeWebhookSubscription(created.id, 'pc_other')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(await service.removeWebhookSubscription(created.id, 'pc_test')).toBe(true);
  });
});
