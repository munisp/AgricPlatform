import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConsentRecord } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { seedConsents, type DeletionRequest } from '../../database/seed-data.js';
import { FinanceService } from '../finance/finance.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';

export interface ProcessingRegisterEntry {
  purpose: string;
  dataCategories: string[];
  lawfulBasis: string;
  retention: string;
}

/** NDPR/NDPA processing register (docs/architecture.md compliance section). */
const PROCESSING_REGISTER: ProcessingRegisterEntry[] = [
  {
    purpose: 'Membership and identity',
    dataCategories: ['phone', 'name', 'language', 'roles'],
    lawfulBasis: 'Contract performance',
    retention: 'Lifetime of membership plus 2 years'
  },
  {
    purpose: 'Learning and certification',
    dataCategories: ['enrolments', 'progress', 'certificates'],
    lawfulBasis: 'Legitimate interest',
    retention: '7 years for certificate verification'
  },
  {
    purpose: 'Marketplace transactions',
    dataCategories: ['listings', 'orders', 'reviews'],
    lawfulBasis: 'Contract performance',
    retention: '7 years for financial records'
  },
  {
    purpose: 'Credit readiness',
    dataCategories: ['documents', 'KYC tier', 'credit signals'],
    lawfulBasis: 'Consent',
    retention: 'Until consent revocation or deletion request'
  },
  {
    purpose: 'Notifications',
    dataCategories: ['channels', 'preferences', 'delivery logs'],
    lawfulBasis: 'Consent',
    retention: '12 months of delivery logs'
  }
];

@Injectable()
export class PrivacyService {
  private readonly consents = new InMemoryRepository<ConsentRecord>(seedConsents);
  private readonly deletionRequests = new InMemoryRepository<DeletionRequest>([]);

  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService
  ) {}

  grantConsent(input: {
    userId: string;
    purpose: string;
    granted: boolean;
    source: string;
  }): ConsentRecord {
    this.users.getById(input.userId);
    const consent: ConsentRecord = {
      id: newId('consent'),
      userId: input.userId,
      purpose: input.purpose,
      granted: input.granted,
      source: input.source,
      grantedAt: new Date().toISOString()
    };
    const created = this.consents.create(consent);
    this.events.publish(
      'privacy.consent.recorded',
      { consentId: created.id, purpose: created.purpose, granted: created.granted },
      input.userId
    );
    return created;
  }

  revokeConsent(id: string, actorId: string): ConsentRecord {
    const updated = this.consents.update(id, { granted: false, revokedAt: new Date().toISOString() });
    this.audit.record({
      actorId,
      action: 'privacy.consent_revoked',
      entityType: 'consent',
      entityId: id
    });
    this.events.publish('privacy.consent.revoked', { consentId: id }, actorId);
    return updated;
  }

  consentsFor(userId: string): ConsentRecord[] {
    return this.consents.find((c) => c.userId === userId);
  }

  /** Single consent record (used for ownership checks before revocation). */
  getConsent(id: string): ConsentRecord {
    return this.consents.getById(id);
  }

  /** Full NDPR data export for a data subject. */
  exportUser(userId: string, actorId: string) {
    const user = this.users.getById(userId);
    const bundle = {
      generatedAt: new Date().toISOString(),
      user,
      profile: this.profiles.get(userId),
      consents: this.consentsFor(userId),
      enrolments: this.learning.enrolmentsForUser(userId),
      certificates: this.learning.certificatesForUser(userId),
      applications: this.opportunities.listApplications({ userId }),
      purchases: this.marketplace.listOrders({ buyerId: userId }),
      sales: this.marketplace.listOrders({ sellerId: userId }),
      documents: this.finance.listDocuments(userId),
      creditProfile: this.finance.creditProfile(userId),
      notifications: this.notifications.list({ userId }),
      notificationPreferences: this.notifications.preferencesFor(userId)
    };
    this.audit.record({
      actorId,
      action: 'privacy.export_requested',
      entityType: 'user',
      entityId: userId
    });
    this.events.publish('privacy.export.requested', { userId }, actorId);
    return bundle;
  }

  requestDeletion(userId: string, actorId: string): DeletionRequest {
    this.users.getById(userId);
    const request: DeletionRequest = {
      id: newId('deletion'),
      userId,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };
    const created = this.deletionRequests.create(request);
    this.audit.record({
      actorId,
      action: 'privacy.deletion_requested',
      entityType: 'user',
      entityId: userId
    });
    this.events.publish('privacy.deletion.requested', { userId, requestId: created.id }, actorId);
    return created;
  }

  confirmDeletion(requestId: string, actorId: string): DeletionRequest {
    const request = this.deletionRequests.findById(requestId);
    if (!request) {
      throw new NotFoundException(`Deletion request '${requestId}' not found`);
    }
    this.users.anonymize(request.userId);
    const updated = this.deletionRequests.update(requestId, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
    this.audit.record({
      actorId,
      action: 'privacy.deletion_completed',
      entityType: 'user',
      entityId: request.userId
    });
    this.events.publish('privacy.user.deleted', { userId: request.userId, requestId }, actorId);
    return updated;
  }

  deletionRequest(id: string): DeletionRequest {
    return this.deletionRequests.getById(id);
  }

  processingRegister(): ProcessingRegisterEntry[] {
    return PROCESSING_REGISTER;
  }
}
