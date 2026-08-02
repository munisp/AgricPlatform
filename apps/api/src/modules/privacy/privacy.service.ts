import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConsentRecord } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  CONSENT_REPOSITORY,
  DELETION_REQUEST_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ConsentRepository } from '../../database/repositories/consent.repository.js';
import type { DeletionRequestRepository } from '../../database/repositories/deletion-request.repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import type { DeletionRequest } from '../../database/seed-data.js';
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
  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(CONSENT_REPOSITORY) private readonly consents: ConsentRepository,
    @Inject(DELETION_REQUEST_REPOSITORY)
    private readonly deletionRequests: DeletionRequestRepository
  ) {}

  async grantConsent(input: {
    userId: string;
    purpose: string;
    granted: boolean;
    source: string;
  }): Promise<ConsentRecord> {
    await this.users.getById(input.userId);
    const consent: ConsentRecord = {
      id: newId('consent'),
      userId: input.userId,
      purpose: input.purpose,
      granted: input.granted,
      source: input.source,
      grantedAt: new Date().toISOString()
    };
    const created = await this.consents.create(consent);
    await this.events.publish(
      'privacy.consent.recorded',
      { consentId: created.id, purpose: created.purpose, granted: created.granted },
      input.userId
    );
    return created;
  }

  async revokeConsent(id: string, actorId: string): Promise<ConsentRecord> {
    const updated = await this.consents.update(id, {
      granted: false,
      revokedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId,
      action: 'privacy.consent_revoked',
      entityType: 'consent',
      entityId: id
    });
    await this.events.publish('privacy.consent.revoked', { consentId: id }, actorId);
    return updated;
  }

  async consentsFor(userId: string): Promise<ConsentRecord[]> {
    return this.consents.find({ userId });
  }

  /** Single consent record (used for ownership checks before revocation). */
  async getConsent(id: string): Promise<ConsentRecord> {
    return this.consents.getById(id);
  }

  /** Full NDPR data export for a data subject. */
  async exportUser(userId: string, actorId: string) {
    const user = await this.users.getById(userId);
    const [
      profile,
      consents,
      enrolments,
      certificates,
      applications,
      purchases,
      sales,
      documents,
      creditProfile,
      notifications,
      notificationPreferences
    ] = await Promise.all([
      this.profiles.get(userId),
      this.consentsFor(userId),
      this.learning.enrolmentsForUser(userId),
      this.learning.certificatesForUser(userId),
      this.opportunities.listApplications({ userId }),
      this.marketplace.listOrders({ buyerId: userId }),
      this.marketplace.listOrders({ sellerId: userId }),
      this.finance.listDocuments(userId),
      this.finance.creditProfile(userId),
      this.notifications.list({ userId }),
      this.notifications.preferencesFor(userId)
    ]);
    const bundle = {
      generatedAt: new Date().toISOString(),
      user,
      profile,
      consents,
      enrolments,
      certificates,
      applications,
      purchases,
      sales,
      documents,
      creditProfile,
      notifications,
      notificationPreferences
    };
    await this.audit.record({
      actorId,
      action: 'privacy.export_requested',
      entityType: 'user',
      entityId: userId
    });
    await this.events.publish('privacy.export.requested', { userId }, actorId);
    return bundle;
  }

  async requestDeletion(userId: string, actorId: string): Promise<DeletionRequest> {
    await this.users.getById(userId);
    const request: DeletionRequest = {
      id: newId('deletion'),
      userId,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };
    const created = await this.deletionRequests.create(request);
    await this.audit.record({
      actorId,
      action: 'privacy.deletion_requested',
      entityType: 'user',
      entityId: userId
    });
    await this.events.publish('privacy.deletion.requested', { userId, requestId: created.id }, actorId);
    return created;
  }

  async confirmDeletion(requestId: string, actorId: string): Promise<DeletionRequest> {
    const request = await this.deletionRequests.findById(requestId);
    if (!request) {
      throw new NotFoundException(`Deletion request '${requestId}' not found`);
    }
    await this.users.anonymize(request.userId);
    const updated = await this.deletionRequests.update(requestId, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId,
      action: 'privacy.deletion_completed',
      entityType: 'user',
      entityId: request.userId
    });
    await this.events.publish('privacy.user.deleted', { userId: request.userId, requestId }, actorId);
    return updated;
  }

  async deletionRequest(id: string): Promise<DeletionRequest> {
    return this.deletionRequests.getById(id);
  }

  processingRegister(): ProcessingRegisterEntry[] {
    return PROCESSING_REGISTER;
  }
}
