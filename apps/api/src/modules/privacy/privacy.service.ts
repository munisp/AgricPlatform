import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { ConsentRecord } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  AUTH_SESSION_REPOSITORY,
  CONSENT_REPOSITORY,
  DELETION_REQUEST_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
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
// Value import (not `import type`): Nest resolves the @Optional()
// EvidenceService dependency through emitted decorator metadata.
import { EvidenceService } from '../evidence/evidence.service.js';

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
  private readonly logger = new Logger(PrivacyService.name);

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
    private readonly deletionRequests: DeletionRequestRepository,
    // V-24: erasure must revoke the subject's auth sessions (mirrors the
    // compliance.service.ts approve() doctrine).
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    // Stage 27 Innovation 13 (optional, additive): NDPA deletion also
    // expunges dispute-evidence blobs the user uploaded, leaving hash
    // tombstones so evidence chains stay verifiable. Optional so the
    // privacy surface boots unchanged when the locker is absent.
    @Optional() private readonly evidence?: EvidenceService
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
    // V-24: erasure must also kill the subject's sessions — an anonymised
    // user holding live refresh tokens would keep using the account (same
    // doctrine as compliance.service.ts approve()).
    await this.sessions.revokeAllForUser(request.userId, new Date().toISOString());
    // One-time remediation (V-24): the legacy path completed erasures
    // WITHOUT revoking sessions, so previously-anonymised users may still
    // hold live refresh-token families. Idempotent sweep, re-run on every
    // confirmation — a no-op once the backlog is drained.
    await this.revokeSessionsForAnonymizedUsers(actorId);
    // Stage 27 Innovation 13: expunge the user's dispute-evidence blobs
    // (object deleted, hash tombstone retained). Failures are logged, never
    // swallowed; the sweep result is auditable via evidence.item.expunged
    // audit events per item.
    if (this.evidence) {
      try {
        const sweep = await this.evidence.expungeForUser(request.userId, actorId);
        if (sweep.failed > 0) {
          this.logger.warn(
            `Evidence expunge sweep for user '${request.userId}' left ${sweep.failed} item(s) ` +
              `unexpunged (${sweep.expunged} expunged) — manual follow-up required`
          );
        }
      } catch (error) {
        this.logger.warn(
          `Evidence expunge sweep for user '${request.userId}' failed: ${(error as Error).message}`
        );
      }
    }
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

  /**
   * One-time remediation (V-24): revokes auth sessions for every previously
   * anonymised user (phone tombstoned to `deleted:<id>` by
   * UsersService.anonymize). Idempotent — revokeAllForUser skips
   * already-revoked sessions — and paged so it cannot truncate on large
   * user bases. Wired into the deletion-confirmation flow (rather than a
   * bootstrap check) so anonymisations performed by ANY path
   * (privacy/admin/compliance) between deployments are covered, and so the
   * sweep is exercised in tests through the public service surface. Audited
   * per run.
   */
  async revokeSessionsForAnonymizedUsers(
    actorId: string
  ): Promise<{ usersScanned: number; sessionsRevoked: number }> {
    const revokedAt = new Date().toISOString();
    let usersScanned = 0;
    let sessionsRevoked = 0;
    let page = 1;
    const pageSize = 500;
    for (;;) {
      const batch = await this.users.list({ page, pageSize });
      const anonymized = batch.data.filter((user) => user.phone.startsWith('deleted:'));
      for (const user of anonymized) {
        usersScanned += 1;
        sessionsRevoked += await this.sessions.revokeAllForUser(user.id, revokedAt);
      }
      if (batch.data.length < pageSize) {
        break;
      }
      page += 1;
    }
    await this.audit.record({
      actorId,
      action: 'privacy.anonymized_sessions_revoked',
      entityType: 'user',
      entityId: actorId,
      metadata: { usersScanned, sessionsRevoked }
    });
    return { usersScanned, sessionsRevoked };
  }

  processingRegister(): ProcessingRegisterEntry[] {
    return PROCESSING_REGISTER;
  }
}
