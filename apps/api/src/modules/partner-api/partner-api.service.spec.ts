import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
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

function makeService(
  options: { consents?: ConsentRecord[]; links?: ExternalAccountLink[] } = {}
) {
  const opportunities = {
    applicationsForPartner: vi.fn(async () => [
      { id: 'app-1', userId: 'user-a', status: 'submitted' },
      { id: 'app-2', userId: 'user-b', status: 'successful' },
      { id: 'app-3', userId: 'user-a', status: 'successful' }
    ]),
    opportunitiesForPartner: vi.fn(async () => [{ id: 'opp-1' }, { id: 'opp-2' }])
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
    const { service, farmRecords } = makeService({
      links: [{ ...accountLink('user-c'), revokedAt: new Date().toISOString() }]
    });
    const result = await service.recordFarmDataPush('user-c', { assets: [] }, 'pc_test');
    expect(result.pendingLink).toBe(true);
    expect(await farmRecords.count({})).toBe(0);
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
