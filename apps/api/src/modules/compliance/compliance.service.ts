import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import type {
  Animal,
  ConsentRecord,
  MarketplaceListing,
  NotificationMessage,
  Order,
  Profile,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { canonicalJSON } from '../../core/audit.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  AUTH_SESSION_REPOSITORY,
  COMPLIANCE_CONSENT_REPOSITORY,
  CONSENT_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
  LISTING_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  ORDER_REPOSITORY,
  PROFILE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import type {
  ComplianceConsentRecord,
  ComplianceConsentRepository,
  DataSubjectRequest,
  DataSubjectRequestRepository
} from '../../database/repositories/compliance.repository.js';
import type { ConsentRepository } from '../../database/repositories/consent.repository.js';
import type { AnimalRepository } from '../../database/repositories/livestock.repository.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import { UsersService } from '../users/users.service.js';

/** sha256 hex digest of the canonical (sorted-key) JSON payload. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJSON(payload)).digest('hex');
}

/**
 * Deterministic pseudonym for retention anonymisation and erasure tombstones
 * (NDPA: anonymised data falls outside the Act; salted hashes stop trivial
 * reversal from the exported data itself).
 */
export function pseudonymFor(userId: string): string {
  // Idempotent: already-tombstoned references pass through unchanged so a
  // repeated retention sweep reports 0 further changes.
  if (userId.startsWith('redacted:')) {
    return userId;
  }
  return `redacted:${createHash('sha256').update(`compliance:${userId}`).digest('hex').slice(0, 16)}`;
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for this resource');
  }
  return actor;
}

function requireAdmin(actor: User | null): User {
  const user = requireUser(actor);
  if (!user.roles.includes('admin')) {
    throw new ForbiddenException('Administrator role required');
  }
  return user;
}

export interface RecordConsentInput {
  purpose: string;
  policyVersion: string;
  source?: string;
}

/** Category of personal data that is NOT part of the DSR export bundle. */
export interface ExportOmission {
  category: string;
  reason: string;
}

/** NDPA s.37 export bundle for one data subject. */
export interface DataSubjectExport {
  generatedAt: string;
  subject: User;
  profile: Profile | null;
  orders: { asBuyer: Order[]; asSeller: Order[] };
  listings: MarketplaceListing[];
  livestock: Animal[];
  consents: { compliance: ComplianceConsentRecord[]; privacy: ConsentRecord[] };
  notifications: NotificationMessage[];
  /**
   * Honest coverage notes: every category a by-user accessor could not reach
   * is listed here instead of being silently absent from the bundle.
   */
  omissions: ExportOmission[];
  coverageNotes: string[];
}

export interface ExportRequestResult {
  request: DataSubjectRequest;
  export: DataSubjectExport;
}

/**
 * NDPA 2023 compliance workflows (Wave COMP): versioned consent capture,
 * data-subject export (s.37) and erasure-by-anonymisation (s.38). Erasure
 * PSEUDONYMISES the identity record and keeps financial, audit and consent
 * rows under legal hold (CBN/PSB transaction-record duties + the audit
 * hash chain's tamper evidence); the retention sweeper anonymises those
 * consent rows once their retention window lapses.
 *
 * TOOLING ONLY — operating these endpoints does not constitute NDPA
 * compliance sign-off; a qualified Nigerian DPO/lawyer must review the
 * policies in docs/compliance/.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(COMPLIANCE_CONSENT_REPOSITORY)
    private readonly consents: ComplianceConsentRepository,
    @Inject(DATA_SUBJECT_REQUEST_REPOSITORY)
    private readonly dsr: DataSubjectRequestRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(CONSENT_REPOSITORY) private readonly legacyConsents: ConsentRepository,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository
  ) {}

  // --------------------------------------------------------------- consents

  async recordConsent(
    actor: User | null,
    input: RecordConsentInput
  ): Promise<ComplianceConsentRecord> {
    const user = requireUser(actor);
    const record: ComplianceConsentRecord = {
      id: newId('consent'),
      userId: user.id,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      grantedAt: new Date().toISOString(),
      source: input.source ?? 'api'
    };
    const created = await this.consents.create(record);
    await this.audit.record({
      actorId: user.id,
      action: 'compliance.consent_recorded',
      entityType: 'compliance_consent',
      entityId: created.id,
      metadata: { purpose: created.purpose, policyVersion: created.policyVersion }
    });
    await this.events.publish(
      'compliance.consent.recorded',
      { consentId: created.id, purpose: created.purpose, policyVersion: created.policyVersion },
      user.id
    );
    return created;
  }

  async revokeConsent(actor: User | null, purpose: string): Promise<ComplianceConsentRecord> {
    const user = requireUser(actor);
    const active = await this.consents.findActive(user.id, purpose);
    if (!active) {
      throw new NotFoundException(`No active consent for purpose '${purpose}'`);
    }
    const revoked = await this.consents.revoke(active.id, new Date().toISOString());
    await this.audit.record({
      actorId: user.id,
      action: 'compliance.consent_revoked',
      entityType: 'compliance_consent',
      entityId: revoked.id,
      metadata: { purpose }
    });
    await this.events.publish(
      'compliance.consent.revoked',
      { consentId: revoked.id, purpose },
      user.id
    );
    return revoked;
  }

  async myConsents(actor: User | null): Promise<ComplianceConsentRecord[]> {
    const user = requireUser(actor);
    return this.consents.findByUser(user.id);
  }

  // ------------------------------------------------------------------- DSR

  /**
   * NDPA s.37: creates the request and completes it synchronously — the
   * bundle is assembled inline and the request's result_ref records the
   * sha256 of the canonical payload so the export is verifiable later.
   */
  async requestExport(actor: User | null): Promise<ExportRequestResult> {
    const user = requireUser(actor);
    const request = await this.dsr.create({
      id: newId('dsr'),
      userId: user.id,
      type: 'export',
      status: 'processing',
      requestedAt: new Date().toISOString()
    });
    const bundle = await this.buildExport(user.id);
    const completed = await this.dsr.update(request.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultRef: `sha256:${payloadDigest(bundle)}`
    });
    await this.audit.record({
      actorId: user.id,
      action: 'compliance.dsr_export_completed',
      entityType: 'data_subject_request',
      entityId: request.id
    });
    await this.events.publish('compliance.dsr.export_completed', { requestId: request.id }, user.id);
    return { request: completed, export: bundle };
  }

  /** NDPA s.38: erasure requests are pending until an admin approves them. */
  async requestErasure(actor: User | null): Promise<DataSubjectRequest> {
    const user = requireUser(actor);
    const existing = await this.dsr.findByUser(user.id);
    if (existing.some((request) => request.type === 'erasure' && request.status === 'pending')) {
      throw new ConflictException('An erasure request is already pending for this account');
    }
    const request = await this.dsr.create({
      id: newId('dsr'),
      userId: user.id,
      type: 'erasure',
      status: 'pending',
      requestedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: user.id,
      action: 'compliance.dsr_erasure_requested',
      entityType: 'data_subject_request',
      entityId: request.id
    });
    await this.events.publish('compliance.dsr.erasure_requested', { requestId: request.id }, user.id);
    return request;
  }

  async myRequests(actor: User | null): Promise<DataSubjectRequest[]> {
    const user = requireUser(actor);
    return this.dsr.findByUser(user.id);
  }

  /**
   * Admin approval of an erasure request: ANONYMISES the identity record
   * (name/phone/email → tombstones) and revokes all sessions. Financial,
   * audit and consent rows are deliberately kept under legal hold — CBN/PSB
   * record-keeping duties and the tamper-evident audit chain must survive;
   * the retention sweeper pseudonymises consent rows once they lapse.
   */
  async approve(actor: User | null, requestId: string): Promise<DataSubjectRequest> {
    const admin = requireAdmin(actor);
    const request = await this.dsr.getById(requestId);
    if (request.type !== 'erasure') {
      throw new BadRequestException('Only erasure requests can be approved');
    }
    if (request.status !== 'pending') {
      throw new ConflictException(`Request '${requestId}' is ${request.status}, not pending`);
    }
    await this.users.anonymize(request.userId);
    await this.sessions.revokeAllForUser(request.userId, new Date().toISOString());
    const auditEvent = await this.audit.record({
      actorId: admin.id,
      action: 'compliance.dsr_erasure_approved',
      entityType: 'data_subject_request',
      entityId: request.id,
      metadata: {
        subjectUserId: request.userId,
        anonymised: ['phone', 'email', 'fullName'],
        legalHold: ['orders', 'ledger', 'audit_events', 'consent_records']
      }
    });
    const completed = await this.dsr.update(requestId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultRef: `audit:${auditEvent.id}`
    });
    await this.events.publish(
      'compliance.dsr.erasure_completed',
      { requestId: request.id, subjectUserId: request.userId },
      admin.id
    );
    return completed;
  }

  async reject(actor: User | null, requestId: string, note: string): Promise<DataSubjectRequest> {
    const admin = requireAdmin(actor);
    if (!note || note.trim().length === 0) {
      throw new BadRequestException('A rejection note is required');
    }
    const request = await this.dsr.getById(requestId);
    if (request.status !== 'pending') {
      throw new ConflictException(`Request '${requestId}' is ${request.status}, not pending`);
    }
    const rejected = await this.dsr.update(requestId, {
      status: 'rejected',
      completedAt: new Date().toISOString(),
      note
    });
    await this.audit.record({
      actorId: admin.id,
      action: 'compliance.dsr_rejected',
      entityType: 'data_subject_request',
      entityId: requestId,
      metadata: { note }
    });
    await this.events.publish('compliance.dsr.rejected', { requestId }, admin.id);
    return rejected;
  }

  // ---------------------------------------------------------- export bundle

  /**
   * Assembles the s.37 bundle through the existing repository ports. Where a
   * port lacks a by-user accessor the category is listed under `omissions`
   * with a pointer to the API that does cover it — the bundle never pretends
   * to be complete.
   */
  private async buildExport(userId: string): Promise<DataSubjectExport> {
    const subject = await this.users.getById(userId);
    const [
      profile,
      purchases,
      sales,
      allListings,
      livestock,
      complianceConsents,
      privacyConsents,
      notifications
    ] = await Promise.all([
      this.profiles.findByUserId(userId),
      this.orders.find({ buyerId: userId }),
      this.orders.find({ sellerId: userId }),
      // ListingCriteria has no sellerId filter (by-user accessor gap), so
      // seller listings are matched by scanning — flagged in coverageNotes.
      this.listings.all(),
      this.animals.find({ ownerUserId: userId }),
      this.consents.findByUser(userId),
      this.legacyConsents.find({ userId }),
      this.notifications.find({ userId })
    ]);
    const listings = allListings.filter((listing) => listing.sellerId === userId);
    return {
      generatedAt: new Date().toISOString(),
      subject,
      profile: profile ?? null,
      orders: { asBuyer: purchases, asSeller: sales },
      listings,
      livestock,
      consents: { compliance: complianceConsents, privacy: privacyConsents },
      notifications,
      omissions: [
        {
          category: 'learning.enrolments_and_certificates',
          reason:
            'No by-user accessor on the learning ports from this module; covered by GET /privacy/export/:userId.'
        },
        {
          category: 'finance.documents_and_credit_profile',
          reason:
            'No by-user accessor on the finance ports from this module; covered by GET /privacy/export/:userId.'
        },
        {
          category: 'community.posts_and_topics',
          reason: 'No by-user accessor exposed for forum content in this wave.'
        }
      ],
      coverageNotes: [
        'listings matched via a full listing scan — ListingCriteria exposes no sellerId filter (by-user accessor gap).'
      ]
    };
  }
}
