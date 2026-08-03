import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Animal, MarketplaceListing, NotificationMessage, Order, Profile, User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import {
  createInMemoryComplianceConsentRepository,
  createInMemoryDataSubjectRequestRepository
} from '../../database/repositories/compliance.repository.js';
import { InMemoryConsentRepository } from '../../database/repositories/consent.repository.js';
import { InMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { InMemoryAnimalRepository } from '../../database/repositories/livestock.repository.js';
import { InMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { InMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { SessionService } from '../auth/session.service.js';
import { UsersService } from '../users/users.service.js';
import { ComplianceService, payloadDigest, pseudonymFor } from './compliance.service.js';

const farmer: User = {
  id: 'user-comp-farmer',
  phone: '+2348090000001',
  email: 'farmer@example.ng',
  fullName: 'Compliance Farmer',
  roles: ['farmer'],
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const other: User = {
  id: 'user-comp-other',
  phone: '+2348090000002',
  fullName: 'Other User',
  roles: ['buyer'],
  preferredLanguage: 'en',
  kycTier: 'tier_0',
  isVerified: false,
  createdAt: '2026-01-02T00:00:00.000Z'
};

const admin: User = {
  id: 'user-comp-admin',
  phone: '+2348090000003',
  fullName: 'Compliance Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-03T00:00:00.000Z'
};

const profile: Profile = {
  userId: farmer.id,
  location: { state: 'Kano', lga: 'Nassarawa' },
  farmingInterests: ['maize'],
  valueChains: ['grains'],
  completionScore: 60,
  badges: []
};

const farmerListing: MarketplaceListing = {
  id: 'listing-comp-1',
  sellerId: farmer.id,
  kind: 'produce',
  title: 'Maize lot',
  quantity: 10,
  unit: 'tonnes',
  priceNaira: 250000,
  location: { state: 'Kano', lga: 'Nassarawa' },
  isActive: true
};

const otherListing: MarketplaceListing = {
  id: 'listing-comp-2',
  sellerId: other.id,
  kind: 'equipment',
  title: 'Tractor',
  quantity: 1,
  unit: 'unit',
  priceNaira: 5000000,
  location: { state: 'Lagos', lga: 'Ikeja' },
  isActive: true
};

const purchase: Order = {
  id: 'order-comp-1',
  listingId: otherListing.id,
  buyerId: farmer.id,
  sellerId: other.id,
  quantity: 1,
  totalNaira: 5000000,
  status: 'completed',
  escrowRequired: false,
  createdAt: '2026-02-01T00:00:00.000Z'
};

const sale: Order = {
  id: 'order-comp-2',
  listingId: farmerListing.id,
  buyerId: other.id,
  sellerId: farmer.id,
  quantity: 2,
  totalNaira: 500000,
  status: 'requested',
  escrowRequired: true,
  createdAt: '2026-02-02T00:00:00.000Z'
};

const animal: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: farmer.id,
  state: 'Kano',
  status: 'alive',
  createdAt: '2026-01-10T00:00:00.000Z',
  updatedAt: '2026-01-10T00:00:00.000Z'
};

const notification: NotificationMessage = {
  id: 'notif-comp-1',
  userId: farmer.id,
  channel: 'sms',
  title: 'Order update',
  body: 'Your order was confirmed',
  status: 'sent',
  createdAt: '2026-02-03T00:00:00.000Z'
};

function build() {
  const users = new UsersService(new InMemoryUserRepository([farmer, other, admin]));
  const audit = new AuditService(createInMemoryAuditRepository());
  const events = { publish: async () => ({}) } as unknown as DomainEventsService;
  const consents = createInMemoryComplianceConsentRepository();
  const dsr = createInMemoryDataSubjectRequestRepository();
  const profiles = new InMemoryProfileRepository([profile]);
  const orders = new InMemoryOrderRepository([purchase, sale]);
  const listings = new InMemoryListingRepository([farmerListing, otherListing]);
  const animals = new InMemoryAnimalRepository([animal]);
  const notifications = new InMemoryNotificationRepository([notification]);
  const legacyConsents = new InMemoryConsentRepository([]);
  const sessions = createInMemoryAuthSessionRepository();
  const sessionService = new SessionService(users, sessions);
  const service = new ComplianceService(
    users,
    audit,
    events,
    consents,
    dsr,
    profiles,
    orders,
    listings,
    animals,
    notifications,
    legacyConsents,
    sessions
  );
  return { service, users, audit, consents, dsr, orders, listings, sessions, sessionService };
}

describe('ComplianceService consents (Wave COMP)', () => {
  it('records a consent with policy version and default source', async () => {
    const { service } = build();
    const record = await service.recordConsent(farmer, { purpose: 'marketing_sms', policyVersion: '2026-06' });
    expect(record.userId).toBe(farmer.id);
    expect(record.policyVersion).toBe('2026-06');
    expect(record.source).toBe('api');
    expect(record.revokedAt).toBeUndefined();
    expect(await service.myConsents(farmer)).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const { service } = build();
    await expect(
      service.recordConsent(null, { purpose: 'marketing_sms', policyVersion: '2026-06' })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('revokes the active consent for a purpose', async () => {
    const { service } = build();
    await service.recordConsent(farmer, { purpose: 'marketing_sms', policyVersion: '2026-06' });
    const revoked = await service.revokeConsent(farmer, 'marketing_sms');
    expect(revoked.revokedAt).toBeDefined();
    // History is preserved: the revoked row is still listed.
    const mine = await service.myConsents(farmer);
    expect(mine).toHaveLength(1);
    expect(mine[0].revokedAt).toBe(revoked.revokedAt);
  });

  it('revoking twice (or an unknown purpose) is a 404', async () => {
    const { service } = build();
    await service.recordConsent(farmer, { purpose: 'marketing_sms', policyVersion: '2026-06' });
    await service.revokeConsent(farmer, 'marketing_sms');
    await expect(service.revokeConsent(farmer, 'marketing_sms')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(service.revokeConsent(farmer, 'never_granted')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('scopes consent history to the caller', async () => {
    const { service } = build();
    await service.recordConsent(farmer, { purpose: 'marketing_sms', policyVersion: '2026-06' });
    await service.recordConsent(other, { purpose: 'data_sharing_partner', policyVersion: '2026-06' });
    expect(await service.myConsents(farmer)).toHaveLength(1);
    expect((await service.myConsents(other))[0].purpose).toBe('data_sharing_partner');
  });
});

describe('ComplianceService data-subject export (NDPA s.37)', () => {
  it('completes synchronously with a shaped, verifiable bundle', async () => {
    const { service } = build();
    const { request, export: bundle } = await service.requestExport(farmer);
    expect(request.type).toBe('export');
    expect(request.status).toBe('completed');
    expect(request.resultRef).toBe(`sha256:${payloadDigest(bundle)}`);

    expect(bundle.subject.id).toBe(farmer.id);
    expect(bundle.profile?.userId).toBe(farmer.id);
    expect(bundle.orders.asBuyer.map((o) => o.id)).toEqual([purchase.id]);
    expect(bundle.orders.asSeller.map((o) => o.id)).toEqual([sale.id]);
    expect(bundle.listings.map((l) => l.id)).toEqual([farmerListing.id]);
    expect(bundle.livestock.map((a) => a.id)).toEqual([animal.id]);
    expect(bundle.notifications.map((n) => n.id)).toEqual([notification.id]);
    expect(bundle.consents.compliance).toEqual([]);
    expect(bundle.consents.privacy).toEqual([]);
  });

  it('declares uncovered categories as explicit omissions', async () => {
    const { service } = build();
    const { export: bundle } = await service.requestExport(farmer);
    const categories = bundle.omissions.map((omission) => omission.category);
    expect(categories).toContain('learning.enrolments_and_certificates');
    expect(categories).toContain('finance.documents_and_credit_profile');
    for (const omission of bundle.omissions) {
      expect(omission.reason.length).toBeGreaterThan(0);
    }
    expect(bundle.coverageNotes.length).toBeGreaterThan(0);
  });

  it('includes recorded consents in the bundle', async () => {
    const { service } = build();
    await service.recordConsent(farmer, { purpose: 'marketing_sms', policyVersion: '2026-06' });
    const { export: bundle } = await service.requestExport(farmer);
    expect(bundle.consents.compliance.map((c) => c.purpose)).toEqual(['marketing_sms']);
  });

  it('scopes request history to the caller', async () => {
    const { service } = build();
    await service.requestExport(farmer);
    await service.requestErasure(other);
    expect(await service.myRequests(farmer)).toHaveLength(1);
    expect((await service.myRequests(other))[0].type).toBe('erasure');
  });
});

describe('ComplianceService erasure (NDPA s.38)', () => {
  it('creates a pending request and rejects duplicates', async () => {
    const { service } = build();
    const request = await service.requestErasure(farmer);
    expect(request.status).toBe('pending');
    await expect(service.requestErasure(farmer)).rejects.toBeInstanceOf(ConflictException);
  });

  it('admin approval anonymises PII but keeps financial rows (legal hold)', async () => {
    const { service, users, orders, listings, sessionService } = build();
    const session = await sessionService.issue(farmer.id);
    const request = await service.requestErasure(farmer);

    const completed = await service.approve(admin, request.id);
    expect(completed.status).toBe('completed');
    expect(completed.resultRef).toMatch(/^audit:/);

    const erased = await users.getById(farmer.id);
    expect(erased.fullName).toBe('Deleted user');
    expect(erased.phone).toBe(`deleted:${farmer.id}`);
    expect(erased.email).toBeUndefined();

    // Sessions revoked: the refresh token no longer rotates.
    await expect(sessionService.refresh(session.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException
    );

    // Financial/audit records survive untouched (CBN/PSB record-keeping).
    expect(await orders.find({ sellerId: farmer.id })).toHaveLength(1);
    expect((await listings.all()).map((l) => l.id)).toContain(farmerListing.id);
  });

  it('non-admin actors cannot approve or reject', async () => {
    const { service } = build();
    const request = await service.requestErasure(farmer);
    await expect(service.approve(other, request.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reject(other, request.id, 'nope')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect((await service.myRequests(farmer))[0].status).toBe('pending');
  });

  it('only pending erasure requests can be approved', async () => {
    const { service } = build();
    const { request: exportRequest } = await service.requestExport(farmer);
    await expect(service.approve(admin, exportRequest.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
    const erasure = await service.requestErasure(farmer);
    await service.approve(admin, erasure.id);
    await expect(service.approve(admin, erasure.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejection requires a note and closes the request', async () => {
    const { service } = build();
    const request = await service.requestErasure(farmer);
    await expect(service.reject(admin, request.id, '   ')).rejects.toBeInstanceOf(
      BadRequestException
    );
    const rejected = await service.reject(admin, request.id, 'Identity verification pending');
    expect(rejected.status).toBe('rejected');
    expect(rejected.note).toBe('Identity verification pending');
    expect(rejected.completedAt).toBeDefined();
  });
});

describe('pseudonymFor', () => {
  it('is deterministic and non-reversing', () => {
    expect(pseudonymFor('user-1')).toBe(pseudonymFor('user-1'));
    expect(pseudonymFor('user-1')).toMatch(/^redacted:[0-9a-f]{16}$/);
    expect(pseudonymFor('user-1')).not.toContain('user-1');
  });
});
