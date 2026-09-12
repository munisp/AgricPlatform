import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentRecord } from '@agric-platform/shared';
import { createInMemoryWebhookSubscriptionRepository } from '../../database/repositories/partner-api.repository.js';
import {
  createInMemoryExternalAccountLinkRepository,
  createInMemoryFarmRecordRepository,
  createInMemoryInboundEventRepository
} from '../../database/repositories/phase3.repository.js';
import {
  PARTNER_SHARE_CONSENT_PURPOSE,
  PartnerApiService
} from './partner-api.service.js';

/**
 * Stage 27, WP-G22 follow-up — disbursement member-binding. The partner
 * write paths may only target users who are members of the calling
 * partner's scope: an application to one of that partner's programmes, or
 * an explicit active `partner_data_sharing` consent record. Out-of-scope
 * targets are 404-indistinguishable from unknown users (WP-G4 convention)
 * and rejected disbursement attempts are audited with the tenant id.
 */

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
  { id: 'app-2', userId: 'user-b', partnerId: 'partner-1', status: 'successful' }
];

const DEFAULT_PROGRAMMES: TestProgramme[] = [
  { id: 'opp-1', partnerId: 'partner-1' },
  { id: 'opp-2', partnerId: 'partner-1' }
];

function makeService(
  options: {
    consents?: ConsentRecord[];
    applications?: TestApplication[];
    programmes?: TestProgramme[];
    knownUsers?: string[];
  } = {}
) {
  const applications = options.applications ?? DEFAULT_APPLICATIONS;
  const programmes = options.programmes ?? DEFAULT_PROGRAMMES;
  const knownUsers = new Set(options.knownUsers ?? ['user-a', 'user-b', 'user-c']);
  const opportunities = {
    applicationsForPartner: vi.fn(async (partnerId: string) =>
      applications.filter((application) => application.partnerId === partnerId)
    ),
    opportunitiesForPartner: vi.fn(async (partnerId: string) =>
      programmes.filter((programme) => programme.partnerId === partnerId)
    )
  };
  const learning = {
    enrolmentsForUser: vi.fn(async (userId: string) => [{ id: `enr-${userId}`, status: 'enrolled' }])
  };
  const users = {
    findById: vi.fn(async (id: string) =>
      knownUsers.has(id) ? { id, fullName: `Name ${id}` } : undefined
    ),
    getById: vi.fn(async (id: string) => {
      if (!knownUsers.has(id)) {
        throw new NotFoundException(`Resource with id '${id}' not found`);
      }
      return { id, fullName: `Name ${id}` };
    })
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
  const service = new PartnerApiService(
    opportunities as never,
    learning as never,
    users as never,
    profiles as never,
    audit as never,
    events as never,
    consentRepo as never,
    createInMemoryWebhookSubscriptionRepository(),
    createInMemoryExternalAccountLinkRepository(),
    createInMemoryFarmRecordRepository(),
    createInMemoryInboundEventRepository()
  );
  return { service, events, audit };
}

describe('PartnerApiService disbursement member-binding (Stage 27 follow-up)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a disbursement to an application-bound member and publishes the event', async () => {
    const { service, events, audit } = makeService();
    const recorded = await service.recordDisbursement(
      'partner-1',
      { userId: 'user-a', amountNgn: 50_000, reference: 'ref-1' },
      'pc_test'
    );
    expect(recorded.userId).toBe('user-a');
    expect(events.publish).toHaveBeenCalledWith(
      'partner.disbursement.recorded',
      expect.objectContaining({ userId: 'user-a', partnerId: 'partner-1' }),
      'pc_test'
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'partner.disbursement.recorded' })
    );
  });

  it('allows a disbursement to a consent-bound member without an application', async () => {
    const { service, events } = makeService({ consents: [consent('user-c')] });
    const recorded = await service.recordDisbursement(
      'partner-1',
      { userId: 'user-c', amountNgn: 10_000 },
      'pc_test'
    );
    expect(recorded.userId).toBe('user-c');
    expect(events.publish).toHaveBeenCalledWith(
      'partner.disbursement.recorded',
      expect.objectContaining({ userId: 'user-c' }),
      'pc_test'
    );
  });

  it('rejects a disbursement to a revoked-consent user with no application (404)', async () => {
    const { service, events } = makeService({ consents: [consent('user-c', true, true)] });
    await expect(
      service.recordDisbursement('partner-1', { userId: 'user-c', amountNgn: 10_000 }, 'pc_test')
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rejects a disbursement to an existing non-member, indistinguishable from nonexistent (404)', async () => {
    const { service, events } = makeService();
    const unbound = await service
      .recordDisbursement('partner-1', { userId: 'user-c', amountNgn: 10_000 }, 'pc_test')
      .catch((error: unknown) => error);
    const ghost = await service
      .recordDisbursement('partner-1', { userId: 'user-ghost', amountNgn: 10_000 }, 'pc_test')
      .catch((error: unknown) => error);
    expect(unbound).toBeInstanceOf(NotFoundException);
    expect(ghost).toBeInstanceOf(NotFoundException);
    expect((unbound as NotFoundException).getStatus()).toBe(404);
    expect((unbound as NotFoundException).message).toBe(
      (ghost as NotFoundException).message.replace('user-ghost', 'user-c')
    );
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rejects a disbursement to a member bound only to a different partner (cross-partner, 404)', async () => {
    const { service, events } = makeService();
    const crossPartner = await service
      .recordDisbursement('partner-2', { userId: 'user-a', amountNgn: 10_000 }, 'pc_other')
      .catch((error: unknown) => error);
    expect(crossPartner).toBeInstanceOf(NotFoundException);
    expect((crossPartner as NotFoundException).getStatus()).toBe(404);
    expect((crossPartner as NotFoundException).message).toBe(
      `Member 'user-a' not found`
    );
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('audits a rejected binding attempt with the tenant id and never publishes', async () => {
    const { service, events, audit } = makeService();
    await expect(
      service.recordDisbursement('partner-1', { userId: 'user-c', amountNgn: 10_000 }, 'pc_test')
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'pc_test',
        action: 'partner.disbursement.member_binding_rejected',
        entityType: 'user',
        entityId: 'user-c',
        metadata: { partnerId: 'partner-1' }
      })
    );
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('keeps the nonexistent-user contract: 404 NotFoundException, no disbursement side effects', async () => {
    const { service, events, audit } = makeService();
    const ghost = await service
      .recordDisbursement('partner-1', { userId: 'user-ghost', amountNgn: 10_000 }, 'pc_test')
      .catch((error: unknown) => error);
    // Pre-binding behaviour was a 404 NotFoundException from the existence
    // check; the status class and the no-write guarantee are unchanged (the
    // message now matches the member-binding shape so membership cannot be
    // enumerated — see the indistinguishability test above).
    expect(ghost).toBeInstanceOf(NotFoundException);
    expect((ghost as NotFoundException).getStatus()).toBe(404);
    expect(events.publish).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'partner.disbursement.recorded' })
    );
  });
});

describe('PartnerApiService enrolment member-binding (Stage 27 follow-up)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enrols an application-bound member into a partner programme', async () => {
    const { service, events } = makeService();
    const recorded = await service.recordEnrolment(
      'partner-1',
      { userId: 'user-a', programmeId: 'opp-1' },
      'pc_test'
    );
    expect(recorded.userId).toBe('user-a');
    expect(events.publish).toHaveBeenCalledWith(
      'partner.enrolment.recorded',
      expect.objectContaining({ userId: 'user-a', programmeId: 'opp-1' }),
      'pc_test'
    );
  });

  it('enrols a consent-bound member without an application', async () => {
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

  it('rejects enrolling a non-member, indistinguishable from nonexistent (404)', async () => {
    const { service, events } = makeService();
    const unbound = await service
      .recordEnrolment('partner-1', { userId: 'user-c', programmeId: 'opp-1' }, 'pc_test')
      .catch((error: unknown) => error);
    const ghost = await service
      .recordEnrolment('partner-1', { userId: 'user-ghost', programmeId: 'opp-1' }, 'pc_test')
      .catch((error: unknown) => error);
    expect(unbound).toBeInstanceOf(NotFoundException);
    expect(ghost).toBeInstanceOf(NotFoundException);
    expect((unbound as NotFoundException).getStatus()).toBe(404);
    expect((unbound as NotFoundException).message).toBe(
      (ghost as NotFoundException).message.replace('user-ghost', 'user-c')
    );
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rejects enrolling a member bound only to a different partner (cross-partner, 404)', async () => {
    const { service, events } = makeService({
      programmes: [...DEFAULT_PROGRAMMES, { id: 'opp-foreign', partnerId: 'partner-2' }]
    });
    const crossPartner = await service
      .recordEnrolment('partner-2', { userId: 'user-a', programmeId: 'opp-foreign' }, 'pc_other')
      .catch((error: unknown) => error);
    expect(crossPartner).toBeInstanceOf(NotFoundException);
    expect((crossPartner as NotFoundException).getStatus()).toBe(404);
    expect(events.publish).not.toHaveBeenCalled();
  });
});
