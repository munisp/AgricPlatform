import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryConsentRepository } from '../../database/repositories/consent.repository.js';
import { createInMemoryDeletionRequestRepository } from '../../database/repositories/deletion-request.repository.js';
import { createInMemoryErasureHoldRepository } from '../../database/repositories/erasure-hold.repository.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import { createInMemoryIvrCallRepository } from '../../database/repositories/ivr-call.repository.js';
import { createInMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { createInMemoryUssdSessionRepository } from '../../database/repositories/ussd-session.repository.js';
import { createInMemoryVoiceSessionRepository } from '../../database/repositories/voice.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { SessionService } from '../auth/session.service.js';
import type { FinanceService } from '../finance/finance.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { pseudonymFor } from '../compliance/compliance.service.js';
import { PrivacyService } from './privacy.service.js';

const PHONE = '+2348011000001';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const sessionRepo = createInMemoryAuthSessionRepository();
  const sessionService = new SessionService(users, sessionRepo);
  const audit = { record: vi.fn(async (input: unknown) => input) };
  const events = { publish: vi.fn(async () => ({})) };
  // V-25 fan-out stores
  const profiles = createInMemoryProfileRepository();
  const farmPlots = createInMemoryFarmPlotRepository();
  const ussdSessions = createInMemoryUssdSessionRepository();
  const ivrCalls = createInMemoryIvrCallRepository();
  const voiceSessions = createInMemoryVoiceSessionRepository();
  const erasureHolds = createInMemoryErasureHoldRepository();
  const service = new PrivacyService(
    users,
    {} as unknown as ProfilesService,
    {} as unknown as LearningService,
    {} as unknown as OpportunitiesService,
    {} as unknown as MarketplaceService,
    {} as unknown as FinanceService,
    {} as unknown as NotificationsService,
    audit as unknown as AuditService,
    events as unknown as DomainEventsService,
    createInMemoryConsentRepository(),
    createInMemoryDeletionRequestRepository(),
    sessionRepo,
    profiles,
    farmPlots,
    ussdSessions,
    ivrCalls,
    voiceSessions,
    erasureHolds
  );
  return {
    service,
    users,
    sessionRepo,
    sessionService,
    audit,
    profiles,
    farmPlots,
    ussdSessions,
    ivrCalls,
    voiceSessions,
    erasureHolds
  };
}

async function makeUser(users: UsersService, phone: string) {
  return users.create({ phone, fullName: 'Privacy Subject', roles: ['farmer'], preferredLanguage: 'en' });
}

describe('PrivacyService erasure session revocation (V-24)', () => {
  it('confirmDeletion anonymises the user AND revokes every refresh session', async () => {
    const { service, users, sessionRepo, sessionService, audit } = build();
    const user = await makeUser(users, PHONE);
    // Two live sessions (two phones) for the subject.
    await sessionService.issue(user.id, {});
    await sessionService.issue(user.id, {});
    expect((await sessionRepo.listForUser(user.id)).filter((s) => !s.revokedAt)).toHaveLength(2);

    const request = await service.requestDeletion(user.id, user.id);
    await service.confirmDeletion(request.id, user.id);

    const erased = await users.getById(user.id);
    expect(erased.phone).toBe(`deleted:${user.id}`);
    expect(erased.fullName).toBe('Deleted user');
    const sessions = await sessionRepo.listForUser(user.id);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.revokedAt).toBeDefined();
    }
    expect(
      audit.record.mock.calls.some(
        ([input]) => (input as { action: string }).action === 'privacy.deletion_completed'
      )
    ).toBe(true);
  });

  it('remediates previously-anonymised users (legacy path) idempotently', async () => {
    const { service, users, sessionRepo, sessionService, audit } = build();
    const legacy = await makeUser(users, '+2348011000002');
    await sessionService.issue(legacy.id, {});
    // Legacy erasure: anonymised WITHOUT session revocation (pre-V-24).
    await users.anonymize(legacy.id);
    expect((await sessionRepo.listForUser(legacy.id)).some((s) => !s.revokedAt)).toBe(true);

    const first = await service.revokeSessionsForAnonymizedUsers('admin-remediation');
    expect(first.usersScanned).toBeGreaterThanOrEqual(1);
    expect(first.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await sessionRepo.listForUser(legacy.id)).every((s) => s.revokedAt)).toBe(true);

    // Idempotent: a second sweep revokes nothing further.
    const second = await service.revokeSessionsForAnonymizedUsers('admin-remediation');
    expect(second.sessionsRevoked).toBe(0);
    expect(
      audit.record.mock.calls.some(
        ([input]) =>
          (input as { action: string }).action === 'privacy.anonymized_sessions_revoked'
      )
    ).toBe(true);
  });

  it('confirmDeletion also drains the legacy backlog via the remediation sweep', async () => {
    const { service, users, sessionRepo, sessionService } = build();
    const legacy = await makeUser(users, '+2348011000003');
    await sessionService.issue(legacy.id, {});
    await users.anonymize(legacy.id);

    const subject = await makeUser(users, '+2348011000004');
    const request = await service.requestDeletion(subject.id, subject.id);
    await service.confirmDeletion(request.id, subject.id);

    expect((await sessionRepo.listForUser(legacy.id)).every((s) => s.revokedAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V-25: erasure fan-out, table-driven from the NDPA data inventory.
// Every inventory category must map to a verified outcome: erased/tombstoned,
// pseudonymised, or a recorded per-category DPO sign-off hold. A category
// mapping to NOTHING fails the test — no silent PII retention.
// ---------------------------------------------------------------------------
describe('PrivacyService erasure fan-out (V-25) — NDPA inventory driven', () => {
  const NDPA = readFileSync(
    resolve(__dirname, '../../../../../docs/compliance/ndpa-data-inventory.md'),
    'utf8'
  );

  function inventoryRows(): Array<{ category: string; action: string }> {
    return NDPA.split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Data') && !line.startsWith('|---'))
      .map((line) => {
        const cells = line.split('|').map((c) => c.trim());
        return { category: cells[1], action: cells[4] ?? '' };
      });
  }

  const PHONE2 = '+2348011000099';

  async function seedPii(h: ReturnType<typeof build>) {
    const user = await h.users.create({
      phone: PHONE2,
      fullName: 'Erasure Subject',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    await h.profiles.upsert({
      userId: user.id,
      location: { state: 'Kano', lga: 'Nassarawa', ward: 'Dakata', latitude: 12.0023, longitude: 8.5098 },
      farmingInterests: ['maize'],
      valueChains: ['grain'],
      bio: 'Grows maize near the river',
      completionScore: 80,
      badges: ['early-adopter']
    });
    await h.farmPlots.create({
      id: 'plot-1',
      ownerUserId: user.id,
      name: 'Home field',
      state: 'Kano',
      lga: 'Nassarawa',
      centroidLat: 12.0023456,
      centroidLong: 8.5098765,
      boundaryGeojson: { type: 'Polygon', coordinates: [[[12.0023, 8.5098]]] },
      sizeHectares: 1.5,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1
    });
    await h.ussdSessions.save({
      sessionId: 'ussd-1',
      phone: PHONE2,
      msisdn: PHONE2,
      state: {},
      currentMenu: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z'
    });
    await h.ivrCalls.save({
      sessionId: 'ivr-1',
      callerNumber: PHONE2,
      state: {},
      currentMenu: 'main',
      dtmfHistory: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z'
    });
    await h.voiceSessions.create({
      id: 'vs-1',
      channel: 'ivr',
      state: 'active',
      phone: PHONE2,
      ninRefHash: 'h',
      language: 'en',
      turns: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    } as never);
    return user;
  }

  it('covers EVERY inventory category (no unmapped row)', () => {
    const rows = inventoryRows();
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(
        CATEGORY_HANDLERS.map((h) => h.match),
        `inventory category '${row.category}' must map to a fan-out handler`
      ).toContainEqual(expect.anything());
    }
  });

  it('post-erasure: zero cleartext PII rows per inventory category, or a recorded hold', async () => {
    const h = build();
    const user = await seedPii(h);
    const request = await h.service.requestDeletion(user.id, user.id);
    await h.service.confirmDeletion(request.id, user.id);

    const pseudonym = pseudonymFor(user.id);
    for (const handler of CATEGORY_HANDLERS) {
      await handler.assert(h, user.id, PHONE2, pseudonym);
    }
    // The cleartext phone is gone from every channel store.
    expect(JSON.stringify(await h.ussdSessions.findById('ussd-1'))).not.toContain(PHONE2);
    expect(JSON.stringify(await h.ivrCalls.findById('ivr-1'))).not.toContain(PHONE2);
    expect(JSON.stringify(await h.voiceSessions.findById('vs-1'))).not.toContain(PHONE2);
    // And the fan-out is audited.
    expect(
      h.audit.record.mock.calls.some(
        ([input]) => (input as { action: string }).action === 'privacy.erasure_fanned_out'
      )
    ).toBe(true);
  });
});

interface Ctx {
  profiles: ReturnType<typeof createInMemoryProfileRepository>;
  farmPlots: ReturnType<typeof createInMemoryFarmPlotRepository>;
  ussdSessions: ReturnType<typeof createInMemoryUssdSessionRepository>;
  ivrCalls: ReturnType<typeof createInMemoryIvrCallRepository>;
  voiceSessions: ReturnType<typeof createInMemoryVoiceSessionRepository>;
  erasureHolds: ReturnType<typeof createInMemoryErasureHoldRepository>;
  users: UsersService;
}

const CATEGORY_HANDLERS: Array<{
  match: string;
  assert: (h: Ctx, userId: string, phone: string, pseudonym: string) => Promise<void>;
}> = [
  {
    match: 'identity.users / auth sessions',
    assert: async (h, userId, phone) => {
      const row = await h.users.getById(userId);
      expect(row.phone).toBe(`deleted:${userId}`);
      expect(row.fullName).toBe('Deleted user');
      expect(JSON.stringify(row)).not.toContain(phone);
    }
  },
  {
    match: 'profiles.member_profiles',
    assert: async (h, userId) => {
      const profile = await h.profiles.findByUserId(userId);
      expect(profile?.bio).toBeUndefined();
      expect(profile?.farmingInterests).toEqual([]);
      expect(profile?.location.ward).toBeUndefined();
      expect(profile?.location.latitude).toBeUndefined();
      expect(profile?.location.state).toBe('redacted');
    }
  },
  {
    match: 'farms.farm_plots',
    assert: async (h, userId) => {
      const [plot] = await h.farmPlots.find({ ownerUserId: userId });
      expect(plot.boundaryGeojson ?? undefined).toBeUndefined();
      // Centroid jittered/stripped to ~1° resolution.
      expect(plot.centroidLat).toBe(Math.round(plot.centroidLat));
      expect(plot.centroidLong).toBe(Math.round(plot.centroidLong));
      expect(plot.name).toBe('Redacted plot');
    }
  },
  {
    match: 'channels.ussd_sessions / ivr_calls',
    assert: async (h, _userId, phone, pseudonym) => {
      expect((await h.ussdSessions.findById('ussd-1'))?.phone).toBe(pseudonym);
      expect((await h.ivrCalls.findById('ivr-1'))?.callerNumber).toBe(pseudonym);
      expect(pseudonym).not.toContain(phone);
    }
  },
  {
    match: 'voice.sessions/turns/cases',
    assert: async (h, _userId, phone, pseudonym) => {
      expect((await h.voiceSessions.findById('vs-1'))?.phone).toBe(pseudonym);
      expect(pseudonym).not.toContain(phone);
    }
  },
  {
    match: 'marketplace.orders / extensions / returns',
    assert: (h, userId) => expectHold(h, userId, 'marketplace_orders')
  },
  {
    match: 'finance (escrow/invoices/shipments + ledger/loans/repayments)',
    assert: (h, userId) => expectHold(h, userId, 'finance_records')
  },
  {
    match: 'consent records (both)',
    assert: (h, userId) => expectHold(h, userId, 'consent_records')
  },
  {
    match: 'audit events',
    assert: (h, userId) => expectHold(h, userId, 'audit_trail')
  },
  {
    match: 'warehouse.receipts',
    assert: (h, userId) => expectHold(h, userId, 'warehouse_receipts')
  },
  {
    match: 'credit.vsla_group_members',
    assert: (h, userId) => expectHold(h, userId, 'credit_vsla')
  },
  {
    match: 'notifications.messages/delivery',
    assert: (h, userId) => expectHold(h, userId, 'notification_records')
  }
];

async function expectHold(h: Ctx, userId: string, category: string) {
  const holds = await h.erasureHolds.find({ userId, category });
  expect(holds, `expected a DPO sign-off hold for ${category}`).toHaveLength(1);
  expect(holds[0].signedOffBy).toBeTruthy();
  expect(holds[0].reason.length).toBeGreaterThan(10);
}
