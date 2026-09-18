import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { ConsentRecord } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  AUTH_SESSION_REPOSITORY,
  CONSENT_REPOSITORY,
  DELETION_REQUEST_REPOSITORY,
  ERASURE_HOLD_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  IVR_CALL_REPOSITORY,
  PROFILE_REPOSITORY,
  USSD_SESSION_REPOSITORY,
  VOICE_SESSION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import type { ConsentRepository } from '../../database/repositories/consent.repository.js';
import type { DeletionRequestRepository } from '../../database/repositories/deletion-request.repository.js';
import type { ErasureHoldRepository } from '../../database/repositories/erasure-hold.repository.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type { IvrCallRepository } from '../../database/repositories/ivr-call.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import type { UssdSessionRepository } from '../../database/repositories/ussd-session.repository.js';
import type { VoiceSessionRepository } from '../../database/repositories/voice.repository.js';
import { pseudonymFor } from '../compliance/compliance.service.js';
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

/**
 * Legal-hold categories (V-25), keyed for the NDPA-inventory table-driven
 * test: data that must outlive an erasure request gets a per-category DPO
 * sign-off hold (privacy.erasure_holds) instead of silently keeping PII.
 */
export const ERASURE_LEGAL_HOLD_CATEGORIES = [
  'marketplace_orders', // orders, extensions, returns — 7-year legal hold
  'finance_records', // escrow, invoices, shipments, ledger, loans, repayments — 7-year
  'consent_records', // consent + lifecycle audit — legal obligation
  'audit_trail', // audit events — legal hold, flag-only
  'warehouse_receipts', // asset ownership records (succession/accounting integrity)
  'credit_vsla', // VSLA membership + credit scoring history (financial records)
  'notification_records' // messages/delivery logs — 12-month retention obligation
] as const;

export type ErasureLegalHoldCategory = (typeof ERASURE_LEGAL_HOLD_CATEGORIES)[number];

export const ERASURE_HOLD_REASONS: Record<ErasureLegalHoldCategory, string> = {
  marketplace_orders: 'NDPA legal hold: orders/extensions/returns retained 7 years (financial records)',
  finance_records: 'NDPA legal hold: escrow/invoices/shipments/ledger/loans/repayments retained 7 years',
  consent_records: 'NDPA legal obligation: consent records retained with lifecycle audit',
  audit_trail: 'NDPA legal hold: audit events retained (flag-only, indefinite)',
  warehouse_receipts:
    'Asset-record integrity: warehouse receipt ownership must survive for succession/accounting',
  credit_vsla: 'Asset-record integrity: VSLA membership and credit history are financial records',
  notification_records: 'NDPA retention obligation: notification delivery records retained 12 months'
};

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
    // V-25: erasure fan-out targets (NDPA inventory categories).
    @Inject(PROFILE_REPOSITORY) private readonly profileRepo: ProfileRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly farmPlots: FarmPlotRepository,
    @Inject(USSD_SESSION_REPOSITORY) private readonly ussdSessions: UssdSessionRepository,
    @Inject(IVR_CALL_REPOSITORY) private readonly ivrCalls: IvrCallRepository,
    @Inject(VOICE_SESSION_REPOSITORY) private readonly voiceSessions: VoiceSessionRepository,
    @Inject(ERASURE_HOLD_REPOSITORY) private readonly erasureHolds: ErasureHoldRepository,
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
    // V-25: capture the channel-linked PII (phone) BEFORE anonymize severs
    // the linkage, so the fan-out can pseudonymise channel records.
    const subject = await this.users.getById(request.userId);
    const subjectPhone = subject.phone;
    await this.users.anonymize(request.userId);
    // V-25: fan out per docs/compliance/ndpa-data-inventory.md —
    // profile tombstone, farm geo strip, channel pseudonymisation, and
    // per-category DPO sign-off holds for legal-hold categories.
    await this.fanOutErasure(request.userId, subjectPhone, actorId);
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
   * NDPA erasure fan-out (V-25, dim05-10/M9): anonymising identity.users
   * alone left cleartext PII in member_profiles, farm plot geometry and the
   * USSD/IVR/voice channel stores. Driven by
   * docs/compliance/ndpa-data-inventory.md:
   * - profiles  → tombstone (location/bio/interests cleared);
   * - farms     → geo strip (boundary dropped, centroid rounded to ~1°);
   * - channels  → pseudonymised with the compliance pseudonymFor pattern;
   * - legal-hold categories (orders/escrow/ledger/consent/audit + asset
   *   records whose ownership FKs must survive for succession/accounting) →
   *   a per-category DPO sign-off hold is RECORDED, never silently kept.
   * Idempotent: holds are keyed (userId, category); re-runs are no-ops.
   */
  private async fanOutErasure(userId: string, phone: string, actorId: string): Promise<void> {
    const pseudonym = pseudonymFor(userId);
    const now = new Date().toISOString();
    const result: Record<string, number | boolean> = {};

    // profiles.member_profiles → tombstone.
    const profile = await this.profileRepo.findByUserId(userId);
    if (profile) {
      await this.profileRepo.upsert({
        userId,
        location: { state: 'redacted', lga: 'redacted' },
        farmingInterests: [],
        valueChains: [],
        badges: [],
        completionScore: 0
      });
    }
    result.profileTombstoned = !!profile;

    // farms.farm_plots → geo strip (boundary dropped; centroid rounded to
    // whole degrees ≈ 111 km — useless as location PII).
    const plots = await this.farmPlots.find({ ownerUserId: userId });
    for (const plot of plots) {
      await this.farmPlots.updateExpected(
        plot.id,
        {
          name: 'Redacted plot',
          centroidLat: Math.round(plot.centroidLat),
          centroidLong: Math.round(plot.centroidLong),
          boundaryGeojson: null as unknown as undefined,
          soilType: undefined,
          updatedAt: now
        },
        { ownerUserId: userId }
      );
    }
    result.farmPlotsStripped = plots.length;

    // Channels → pseudonymise phone-shaped PII (compliance pseudonymFor
    // doctrine; hashes at rest where the channel already stores hashes).
    result.ussdSessionsPseudonymised = await this.ussdSessions.pseudonymiseForPhone(
      phone,
      pseudonym
    );
    result.ivrCallsPseudonymised = await this.ivrCalls.pseudonymiseForPhone(phone, pseudonym);
    let voiceSessions = 0;
    for (const session of await this.voiceSessions.find({ phone })) {
      await this.voiceSessions.update(session.id, { phone: pseudonym });
      voiceSessions += 1;
    }
    result.voiceSessionsPseudonymised = voiceSessions;

    // Legal-hold categories → per-category DPO sign-off hold (the confirming
    // admin acts as the DPO signatory), instead of silently keeping PII.
    for (const category of ERASURE_LEGAL_HOLD_CATEGORIES) {
      const existing = await this.erasureHolds.find({ userId, category });
      if (existing.length === 0) {
        await this.erasureHolds.create({
          id: newId('erasurehold'),
          userId,
          category,
          reason: ERASURE_HOLD_REASONS[category],
          signedOffBy: actorId,
          signedOffAt: now
        });
      }
    }
    result.legalHoldsRecorded = ERASURE_LEGAL_HOLD_CATEGORIES.length;

    await this.audit.record({
      actorId,
      action: 'privacy.erasure_fanned_out',
      entityType: 'user',
      entityId: userId,
      metadata: result
    });
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
