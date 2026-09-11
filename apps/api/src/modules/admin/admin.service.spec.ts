import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@agric-platform/shared';
import { AuditAnchorService } from '../../core/audit-anchor.service.js';
import { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import type { OutboxSweeperService } from '../../core/outbox-sweeper.service.js';
import { createInMemoryAuditAnchorRepository } from '../../database/repositories/audit-anchor.repository.js';
import { InMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { SessionService } from '../auth/session.service.js';
import type { CommunityService } from '../community/community.service.js';
import type { FinanceService } from '../finance/finance.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';
import { AdminService } from './admin.service.js';

/**
 * Focused on the account-status security path (Fix Wave 1, G1): suspension
 * must revoke every refresh-token session family immediately. The other
 * collaborators are unused by setStatus and stubbed.
 */
function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const sessions = createInMemoryAuthSessionRepository();
  const sessionService = new SessionService(users, sessions);
  const audit = { record: async () => ({}) } as unknown as AuditService;
  const domainEvents = { publish: async () => ({}) } as unknown as DomainEventsService;
  const stub = {} as never;
  const admin = new AdminService(
    users,
    audit,
    domainEvents,
    stub as CommunityService,
    stub as FinanceService,
    stub as OpportunitiesService,
    stub as LearningService,
    stub as MarketplaceService,
    stub as OutboxSweeperService,
    sessions
  );
  return { admin, users, sessions, sessionService };
}

describe('AdminService account suspension (G1)', () => {
  it('suspending a user revokes ALL their session families across devices', async () => {
    const { admin, sessionService } = build();
    const phone = await sessionService.issue('user-aisha', { userAgent: 'phone' });
    const kiosk = await sessionService.issue('user-aisha', { userAgent: 'kiosk' });

    const view = await admin.setStatus('user-aisha', 'suspended', 'user-admin');
    expect(view.accountStatus).toBe('suspended');

    // Rotation afterwards fails for every family.
    await expect(sessionService.refresh(phone.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(sessionService.refresh(kiosk.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('leaves other users sessions untouched when one user is suspended', async () => {
    const { admin, sessionService } = build();
    const victim = await sessionService.issue('user-aisha');
    const bystander = await sessionService.issue('user-hassan');

    await admin.setStatus('user-aisha', 'suspended', 'user-admin');

    await expect(sessionService.refresh(victim.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(sessionService.refresh(bystander.refreshToken)).resolves.toMatchObject({
      user: { id: 'user-hassan' }
    });
  });

  it('un-suspending restores the account status (new logins work again)', async () => {
    const { admin, users, sessionService } = build();
    await sessionService.issue('user-aisha');
    await admin.setStatus('user-aisha', 'suspended', 'user-admin');

    const restored = await admin.setStatus('user-aisha', 'active', 'user-admin');
    expect(restored.accountStatus).toBe('active');
    expect(await users.statusFor('user-aisha')).toBe('active');

    const fresh = await sessionService.issue('user-aisha');
    await expect(sessionService.refresh(fresh.refreshToken)).resolves.toMatchObject({
      user: { id: 'user-aisha' }
    });
  });
});

/**
 * Stage 23 anchoring checkpoints through the admin surface: on-demand anchor
 * creation/listing and the combined event-chain + anchor-chain verification
 * (tail-truncation gap detection).
 */

/** Test subclass that simulates an attacker deleting the chain tail. */
class TruncatableAuditRepository extends InMemoryAuditRepository {
  truncate(keep: number): void {
    (this as unknown as { events: AuditEvent[] }).events.length = keep;
  }
}

describe('AdminService audit anchoring (Stage 23)', () => {
  function buildAnchored() {
    const users = new UsersService(createInMemoryUserRepository());
    const sessions = createInMemoryAuthSessionRepository();
    const auditRepository = new TruncatableAuditRepository();
    const anchorRepository = createInMemoryAuditAnchorRepository();
    const audit = new AuditService(auditRepository);
    const auditAnchors = new AuditAnchorService(auditRepository, anchorRepository, {}, null);
    const stub = {} as never;
    const admin = new AdminService(
      users,
      audit,
      stub as DomainEventsService,
      stub as CommunityService,
      stub as FinanceService,
      stub as OpportunitiesService,
      stub as LearningService,
      stub as MarketplaceService,
      stub as OutboxSweeperService,
      sessions,
      undefined,
      undefined,
      auditAnchors
    );
    return { admin, auditRepository };
  }

  it('creates and lists anchors on demand over the live chain tip', async () => {
    const { admin } = buildAnchored();
    await admin.setVerified('user-aisha', true, 'user-admin');

    const anchor = await admin.createAuditAnchor();
    expect(anchor.eventCount).toBe(1);
    expect(anchor.anchorHash).toMatch(/^[0-9a-f]{64}$/);

    const listed = await admin.listAuditAnchors();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(anchor.id);
  });

  it('verifyAuditLog combines event-chain and anchor checks', async () => {
    const { admin } = buildAnchored();
    await admin.setVerified('user-aisha', true, 'user-admin');
    await admin.createAuditAnchor();

    const result = await admin.verifyAuditLog();
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.anchors).toEqual({ valid: true, checked: 1 });
  });

  it('verifyAuditLog fails loudly with a truncation gap after tail deletion', async () => {
    const { admin, auditRepository } = buildAnchored();
    await admin.setVerified('user-aisha', true, 'user-admin');
    await admin.setVerified('user-hassan', true, 'user-admin');
    await admin.setVerified('user-aisha', false, 'user-admin');
    const anchor = await admin.createAuditAnchor();

    // Attacker/bug deletes the chain tail; the remaining chain is still valid.
    auditRepository.truncate(1);

    const result = await admin.verifyAuditLog();
    expect(result.valid).toBe(false);
    expect(result.anchors).toMatchObject({
      valid: false,
      checked: 1,
      gap: {
        reason: 'event_count_regression',
        anchorId: anchor.id,
        anchoredEventCount: 3,
        actualEventCount: 1
      }
    });
  });
});
