import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { NotificationMessage, User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import type {
  ComplianceConsentRecord,
  DataSubjectRequest
} from '../../database/repositories/compliance.repository.js';
import {
  InMemoryComplianceConsentRepository,
  InMemoryDataSubjectRequestRepository,
  InMemoryRetentionPolicyRepository
} from '../../database/repositories/compliance.repository.js';
import { InMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import { ComplianceRetentionService } from './compliance-retention.service.js';
import { pseudonymFor } from './compliance.service.js';

const admin: User = {
  id: 'user-ret-admin',
  phone: '+2348090000099',
  fullName: 'Retention Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const member: User = { ...admin, id: 'user-ret-member', roles: ['farmer'] };

const DAYS = 86_400_000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAYS).toISOString();

const oldRevokedConsent: ComplianceConsentRecord = {
  id: 'consent-ret-old',
  userId: 'user-ret-subject',
  purpose: 'marketing_sms',
  policyVersion: '2024-01',
  grantedAt: isoDaysAgo(900),
  revokedAt: isoDaysAgo(800),
  source: 'web'
};

const recentRevokedConsent: ComplianceConsentRecord = {
  id: 'consent-ret-recent',
  userId: 'user-ret-subject',
  purpose: 'marketing_email',
  policyVersion: '2026-01',
  grantedAt: isoDaysAgo(30),
  revokedAt: isoDaysAgo(10),
  source: 'web'
};

const activeConsent: ComplianceConsentRecord = {
  id: 'consent-ret-active',
  userId: 'user-ret-subject',
  purpose: 'data_sharing_partner',
  policyVersion: '2026-01',
  grantedAt: isoDaysAgo(900),
  source: 'agent'
};

const oldClosedDsr: DataSubjectRequest = {
  id: 'dsr-ret-old',
  userId: 'user-ret-subject',
  type: 'export',
  status: 'completed',
  requestedAt: isoDaysAgo(1200),
  completedAt: isoDaysAgo(1200),
  resultRef: 'sha256:abc'
};

const pendingDsr: DataSubjectRequest = {
  id: 'dsr-ret-pending',
  userId: 'user-ret-subject',
  type: 'erasure',
  status: 'pending',
  requestedAt: isoDaysAgo(1200)
};

const oldNotification: NotificationMessage = {
  id: 'notif-ret-old',
  userId: 'user-ret-subject',
  channel: 'sms',
  title: 'Old',
  body: 'Old notification',
  status: 'sent',
  createdAt: isoDaysAgo(400)
};

const recentNotification: NotificationMessage = {
  id: 'notif-ret-recent',
  userId: 'user-ret-subject',
  channel: 'sms',
  title: 'Recent',
  body: 'Recent notification',
  status: 'sent',
  createdAt: isoDaysAgo(5)
};

function build(policySeed?: ConstructorParameters<typeof InMemoryRetentionPolicyRepository>[0]) {
  const audit = new AuditService(createInMemoryAuditRepository());
  const policies = new InMemoryRetentionPolicyRepository(policySeed);
  const consents = new InMemoryComplianceConsentRepository([
    oldRevokedConsent,
    recentRevokedConsent,
    activeConsent
  ]);
  const dsr = new InMemoryDataSubjectRequestRepository([oldClosedDsr, pendingDsr]);
  const notifications = new InMemoryNotificationRepository([oldNotification, recentNotification]);
  const service = new ComplianceRetentionService(audit, policies, consents, dsr, notifications);
  return { service, policies, consents, dsr, notifications };
}

describe('ComplianceRetentionService policies', () => {
  it('seeds the documented default policies', async () => {
    const { service } = build();
    const policies = await service.listPolicies();
    expect(policies.map((p) => p.entity)).toEqual([
      'compliance.consent_records',
      'compliance.data_subject_requests',
      'notifications.messages'
    ]);
    expect(policies.find((p) => p.entity === 'notifications.messages')?.anonymizeNotDelete).toBe(false);
  });

  it('upserts a policy (admin only)', async () => {
    const { service } = build();
    await expect(
      service.upsertPolicy(member, { entity: 'notifications.messages', retainDays: 90, anonymizeNotDelete: true })
    ).rejects.toBeInstanceOf(ForbiddenException);
    const saved = await service.upsertPolicy(admin, {
      entity: 'notifications.messages',
      retainDays: 90,
      anonymizeNotDelete: true
    });
    expect(saved.retainDays).toBe(90);
    expect((await service.listPolicies()).find((p) => p.entity === 'notifications.messages')?.retainDays).toBe(90);
  });
});

describe('ComplianceRetentionService sweep', () => {
  it('requires an administrator', async () => {
    const { service } = build();
    await expect(service.sweep(null)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.sweep(member)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dry-run (the default) counts expired rows without mutating them', async () => {
    const { service, consents, dsr, notifications } = build();
    const result = await service.sweep(admin);
    expect(result.dryRun).toBe(true);
    const byEntity = Object.fromEntries(result.results.map((r) => [r.entity, r]));

    expect(byEntity['compliance.consent_records'].matched).toBe(1); // only the old revoked consent
    expect(byEntity['compliance.consent_records'].affected).toBe(0);
    expect(byEntity['compliance.data_subject_requests'].matched).toBe(1); // old closed DSR only
    expect(byEntity['notifications.messages'].matched).toBe(1);
    expect(result.totals.affected).toBe(0);

    // Nothing changed.
    expect((await consents.findById(oldRevokedConsent.id))?.userId).toBe('user-ret-subject');
    expect((await dsr.findById(oldClosedDsr.id))?.userId).toBe('user-ret-subject');
    expect(await notifications.findById(oldNotification.id)).toBeDefined();
  });

  it('execute anonymises consent/DSR rows and purges notifications per policy', async () => {
    const { service, consents, dsr, notifications } = build();
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(result.totals.affected).toBe(3);

    // Consent row kept, personal reference tombstoned (proof of lawful basis survives).
    const anonymisedConsent = await consents.findById(oldRevokedConsent.id);
    expect(anonymisedConsent?.userId).toBe(pseudonymFor('user-ret-subject'));
    expect(anonymisedConsent?.revokedAt).toBe(oldRevokedConsent.revokedAt);
    // DSR row kept and tombstoned; pending DSR is NOT in scope.
    expect((await dsr.findById(oldClosedDsr.id))?.userId).toBe(pseudonymFor('user-ret-subject'));
    expect((await dsr.findById(pendingDsr.id))?.userId).toBe('user-ret-subject');
    // Notifications policy says delete: the old one is gone, the recent one stays.
    expect(await notifications.findById(oldNotification.id)).toBeUndefined();
    expect(await notifications.findById(recentNotification.id)).toBeDefined();
    // In-window and active consents untouched.
    expect((await consents.findById(recentRevokedConsent.id))?.userId).toBe('user-ret-subject');
    expect((await consents.findById(activeConsent.id))?.revokedAt).toBeUndefined();
  });

  it('anonymize_not_delete=false purges rows instead of tombstoning them', async () => {
    const { service, consents } = build([
      {
        entity: 'compliance.consent_records',
        retainDays: 730,
        anonymizeNotDelete: false,
        updatedAt: isoDaysAgo(1)
      }
    ]);
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0].action).toBe('purge');
    expect(result.results[0].affected).toBe(1);
    expect(await consents.findById(oldRevokedConsent.id)).toBeUndefined();
    expect(await consents.findById(recentRevokedConsent.id)).toBeDefined();
  });

  it('reports unknown entities as skipped instead of failing', async () => {
    const { service } = build([
      { entity: 'unknown.entity', retainDays: 30, anonymizeNotDelete: true, updatedAt: isoDaysAgo(1) }
    ]);
    const result = await service.sweep(admin, { dryRun: false });
    expect(result.results[0].action).toBe('skipped');
    expect(result.results[0].note).toContain('no retention handler');
    expect(result.totals.skipped).toBe(1);
  });

  it('a second execute changes nothing further (idempotent tombstones)', async () => {
    const { service, consents } = build();
    const first = await service.sweep(admin, { dryRun: false });
    expect(first.totals.affected).toBe(3);
    const second = await service.sweep(admin, { dryRun: false });
    expect(second.totals.affected).toBe(0);
    // Tombstoned consent/DSR rows still match the time window (they are kept
    // by design) but anonymisation is a no-op on the second pass.
    expect(second.totals.matched).toBe(2);
    expect((await consents.findById(oldRevokedConsent.id))?.userId).toBe(
      pseudonymFor('user-ret-subject')
    );
  });
});
