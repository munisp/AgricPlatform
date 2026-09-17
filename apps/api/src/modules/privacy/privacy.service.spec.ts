import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryConsentRepository } from '../../database/repositories/consent.repository.js';
import { createInMemoryDeletionRequestRepository } from '../../database/repositories/deletion-request.repository.js';
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
import { PrivacyService } from './privacy.service.js';

const PHONE = '+2348011000001';

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const sessionRepo = createInMemoryAuthSessionRepository();
  const sessionService = new SessionService(users, sessionRepo);
  const audit = { record: vi.fn(async (input: unknown) => input) };
  const events = { publish: vi.fn(async () => ({})) };
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
    sessionRepo
  );
  return { service, users, sessionRepo, sessionService, audit };
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
