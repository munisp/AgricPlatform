import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Enrolment, Opportunity, Profile, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CONSENT_REPOSITORY,
  EXTERNAL_ACCOUNT_LINK_REPOSITORY,
  FARM_RECORD_REPOSITORY,
  INBOUND_EVENT_REPOSITORY,
  WEBHOOK_SUBSCRIPTION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ConsentRepository } from '../../database/repositories/consent.repository.js';
import type {
  WebhookSubscription,
  WebhookSubscriptionRepository
} from '../../database/repositories/partner-api.repository.js';
import type {
  ExternalAccountLinkRepository,
  FarmRecord,
  FarmRecordRepository,
  InboundEventRepository
} from '../../database/repositories/phase3.repository.js';
import { LearningService } from '../learning/learning.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { PARTNER_EVENT_TYPES, type PartnerEventType } from './webhook-dispatch.service.js';

/** Consent purpose required before any member-level data leaves the partner API. */
export const PARTNER_SHARE_CONSENT_PURPOSE = 'partner_data_sharing';

export interface ConsentedParticipant {
  userId: string;
  name: string;
  state?: string;
}

export interface PartnerImpactAggregate {
  partnerId: string;
  programmes: number;
  participants: number;
  consentedParticipants: number;
  applications: number;
  completedTrainings: number;
}

export interface DisbursementEvent {
  id: string;
  partnerId: string;
  userId: string;
  amountNgn: number;
  programmeId?: string;
  reference?: string;
  recordedAt: string;
}

export interface PartnerEnrolmentEvent {
  id: string;
  partnerId: string;
  userId: string;
  programmeId: string;
  cohortLabel?: string;
  recordedAt: string;
}

/** Subscription view safe for API responses (secret omitted). */
export type PublicWebhookSubscription = Omit<WebhookSubscription, 'secret'>;

export interface FarmDataPushResult {
  id: string;
  userId: string;
  accepted: boolean;
  receivedAt: string;
  /** True when the payload was persisted against an external account link. */
  linked: boolean;
  /** integrations.farm_records id when linked. */
  farmRecordId?: string;
  /** True when no linkage exists; the payload is ledgered pending a link. */
  pendingLink?: boolean;
}

/**
 * Partner API business surface (wave P5d). Member-level reads are gated on
 * an active `partner_data_sharing` consent record; aggregates never expose
 * PII. Writes publish domain events so the webhook dispatcher can fan them
 * out to subscribed partner URLs.
 */
@Injectable()
export class PartnerApiService {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly learning: LearningService,
    private readonly users: UsersService,
    private readonly profiles: ProfilesService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(CONSENT_REPOSITORY) private readonly consents: ConsentRepository,
    @Inject(WEBHOOK_SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: WebhookSubscriptionRepository,
    @Inject(EXTERNAL_ACCOUNT_LINK_REPOSITORY)
    private readonly accountLinks: ExternalAccountLinkRepository,
    @Inject(FARM_RECORD_REPOSITORY) private readonly farmRecords: FarmRecordRepository,
    @Inject(INBOUND_EVENT_REPOSITORY) private readonly inboundEvents: InboundEventRepository
  ) {}

  /** True when the user holds an active partner-sharing consent. */
  async hasSharingConsent(userId: string): Promise<boolean> {
    const records = await this.consents.find({ userId });
    return records.some(
      (record) =>
        record.purpose === PARTNER_SHARE_CONSENT_PURPOSE && record.granted && !record.revokedAt
    );
  }

  /** Programme participants, restricted to members with active consent. */
  async consentedParticipation(partnerId: string): Promise<ConsentedParticipant[]> {
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    const seen = new Set<string>();
    const participants: ConsentedParticipant[] = [];
    for (const application of applications) {
      if (seen.has(application.userId)) continue;
      seen.add(application.userId);
      if (!(await this.hasSharingConsent(application.userId))) continue;
      const user = await this.users.findById(application.userId);
      if (!user) continue;
      const profile = await this.profiles.get(user.id).catch(() => undefined);
      participants.push({
        userId: user.id,
        name: user.fullName,
        state: profile?.location.state
      });
    }
    return participants;
  }

  /** Aggregate impact metrics — counts only, never member-level PII. */
  async impactAggregate(partnerId: string): Promise<PartnerImpactAggregate> {
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    const uniqueUsers = new Set(applications.map((application) => application.userId));
    const consented = await this.consentedParticipation(partnerId);
    let completedTrainings = 0;
    for (const participant of consented) {
      const enrolments = await this.learning.enrolmentsForUser(participant.userId);
      completedTrainings += enrolments.filter((enrolment) => enrolment.status === 'completed')
        .length;
    }
    return {
      partnerId,
      programmes: (await this.opportunities.opportunitiesForPartner(partnerId)).length,
      participants: uniqueUsers.size,
      consentedParticipants: consented.length,
      applications: applications.length,
      completedTrainings
    };
  }

  /** Application counts for a partner (aggregate, no PII). */
  async applicationCount(partnerId: string): Promise<{ partnerId: string; applications: number }> {
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    return { partnerId, applications: applications.length };
  }

  /**
   * Consented member profile lookup (lender credit-check style).
   *
   * Partner binding (Stage 27, WP-G4 — V3 middleware audit): the requested
   * member must be bound to the caller's partner organisation, i.e. hold at
   * least one application to one of that partner's programmes — the same
   * member↔partner binding `consentedParticipation` uses. Unbound ids raise
   * NotFoundException with the same shape as an unknown user, so partner
   * membership cannot be enumerated (repo convention: cross-tenant lookups
   * are 404, see `recordEnrolment`). Consent is checked after binding; a
   * bound member without active `partner_data_sharing` consent is a 403 —
   * the caller already knows its own applicants, so no extra signal leaks.
   *
   * Audit attribution: the actor is the partner client (never the member),
   * the member is the subject (entityType user / entityId userId).
   */
  async consentedMemberProfile(
    userId: string,
    partnerId: string,
    actorId: string
  ): Promise<{ user: User; profile: Profile; enrolments: Enrolment[] }> {
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    if (!applications.some((application) => application.userId === userId)) {
      throw new NotFoundException(`Member '${userId}' not found`);
    }
    if (!(await this.hasSharingConsent(userId))) {
      throw new ForbiddenException(
        'Member has not granted partner_data_sharing consent (or it was revoked)'
      );
    }
    const user = await this.users.getById(userId);
    const profile = await this.profiles.get(userId);
    const enrolments = await this.learning.enrolmentsForUser(userId);
    await this.audit.record({
      actorId,
      action: 'partner.member_profile.read',
      entityType: 'user',
      entityId: userId,
      metadata: { partnerId }
    });
    return { user, profile, enrolments };
  }

  /**
   * Member↔partner scope guard for partner writes (Stage 27, WP-G22 —
   * extends the WP-G4 binding pattern to the write paths). A member is in
   * the partner's scope when they hold at least one application to one of
   * that partner's programmes (the same binding `consentedParticipation`
   * and WP-G4's member-profile read use), OR an explicit active
   * `partner_data_sharing` consent record. Out-of-scope members raise
   * NotFoundException with the same shape WP-G4 uses for an unknown user,
   * so partner membership cannot be enumerated through the write paths.
   */
  private async assertMemberInScope(partnerId: string, userId: string): Promise<void> {
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    const bound = applications.some((application) => application.userId === userId);
    if (!bound && !(await this.hasSharingConsent(userId))) {
      throw new NotFoundException(`Member '${userId}' not found`);
    }
  }

  /**
   * Programme binding for disbursements (Stage 27, WP-G22): a referenced
   * loan/programme must belong to this partner — or be unassigned
   * (partnerId unset), which any partner may record against per the
   * existing domain rules (opportunities carry an optional partnerId; there
   * is no separate claim workflow). Foreign programmes raise the same 404
   * shape as an unknown id, so programme ownership cannot be probed.
   */
  private async assertProgrammeInScope(partnerId: string, programmeId: string): Promise<void> {
    let programme: Opportunity | undefined;
    try {
      programme = await this.opportunities.get(programmeId);
    } catch (error: unknown) {
      if (!(error instanceof NotFoundException)) throw error;
      programme = undefined;
    }
    if (!programme || (programme.partnerId !== undefined && programme.partnerId !== partnerId)) {
      throw new NotFoundException(`Programme '${programmeId}' not found`);
    }
  }

  /** Records a disbursement event and publishes it for webhook fan-out. */
  async recordDisbursement(
    partnerId: string,
    input: { userId: string; amountNgn: number; programmeId?: string; reference?: string },
    actorId: string
  ): Promise<DisbursementEvent> {
    if (input.programmeId) {
      await this.assertProgrammeInScope(partnerId, input.programmeId);
    }
    // WP-G22 follow-up (disbursement member-binding): the disbursement
    // subject must be a member in this partner's scope — bound via an
    // application to one of its programmes, or an explicit active consent
    // record. Previously any existing userId was accepted, so a partner
    // could record money movement against a user it has no relationship
    // with. The check runs before the existence lookup so out-of-scope
    // and unknown users stay 404-indistinguishable (WP-G4 convention).
    try {
      await this.assertMemberInScope(partnerId, input.userId);
    } catch (error: unknown) {
      // Security-relevant: a partner attempted a money event against a
      // member outside its tenant scope — audit with the tenant id.
      await this.audit.record({
        actorId,
        action: 'partner.disbursement.member_binding_rejected',
        entityType: 'user',
        entityId: input.userId,
        metadata: { partnerId }
      });
      throw error;
    }
    await this.users.getById(input.userId);
    const event: DisbursementEvent = {
      id: newId('disb'),
      partnerId,
      userId: input.userId,
      amountNgn: input.amountNgn,
      programmeId: input.programmeId,
      reference: input.reference,
      recordedAt: new Date().toISOString()
    };
    await this.audit.record({
      actorId,
      action: 'partner.disbursement.recorded',
      entityType: 'disbursement',
      entityId: event.id,
      metadata: { partnerId, amountNgn: input.amountNgn }
    });
    await this.events.publish('partner.disbursement.recorded', event, actorId);
    return event;
  }

  /** Records a partner programme enrolment and publishes it for fan-out. */
  async recordEnrolment(
    partnerId: string,
    input: { userId: string; programmeId: string; cohortLabel?: string },
    actorId: string
  ): Promise<PartnerEnrolmentEvent> {
    // WP-G22: the enrollee must be a member in this partner's scope (bound
    // via an application to one of its programmes, or an explicit consent
    // record) — previously any userId was accepted.
    await this.assertMemberInScope(partnerId, input.userId);
    await this.users.getById(input.userId);
    const programmes = await this.opportunities.opportunitiesForPartner(partnerId);
    if (!programmes.some((programme: Opportunity) => programme.id === input.programmeId)) {
      // 404 indistinguishable from an unknown programme (WP-G4 convention:
      // cross-tenant lookups must not leak ownership).
      throw new NotFoundException(`Programme '${input.programmeId}' not found`);
    }
    const event: PartnerEnrolmentEvent = {
      id: newId('penrol'),
      partnerId,
      userId: input.userId,
      programmeId: input.programmeId,
      cohortLabel: input.cohortLabel,
      recordedAt: new Date().toISOString()
    };
    await this.audit.record({
      actorId,
      action: 'partner.enrolment.recorded',
      entityType: 'partner_enrolment',
      entityId: event.id,
      metadata: { partnerId, programmeId: input.programmeId }
    });
    await this.events.publish('partner.enrolment.recorded', event, actorId);
    return event;
  }

  /**
   * Accepts a farmOS-compatible farm data push (wave P6b: now persisted).
   * The payload is validated for shape only, stored in
   * integrations.farm_records (record_type partner_push) against the
   * member's active external account link when one exists, and forwarded as
   * a domain event; no PII beyond the owning user id.
   *
   * Pending-link path: farm_records.link_id is FK-constrained to
   * external_account_links, so when the member has no active link the push
   * cannot ride farm_records without a schema change. It is ledgered instead
   * as a replay-safe inbound event (event_type farm_data.pending_link) whose
   * payload carries the `pending-link:{userId}` marker; a later account
   * linkage can replay these into farm_records.
   *
   * Tenant binding (Stage 27, WP-G22): the caller's credential must be bound
   * to a partner organisation (enforced by the controller via the token's
   * partnerId claim — unbound credentials are 403, fail closed), and the
   * subject farmer must be in that partner's scope — bound via an
   * application to one of the partner's programmes or an explicit active
   * `partner_data_sharing` consent record. Unbound subjects are 404,
   * indistinguishable from an unknown user. Audit attribution: the actor is
   * the partner client, the farmer is the subject (entityType user).
   */
  async recordFarmDataPush(
    partnerId: string,
    userId: string,
    payload: Record<string, unknown>,
    actorId: string
  ): Promise<FarmDataPushResult> {
    await this.assertMemberInScope(partnerId, userId);
    await this.users.getById(userId);
    const result: FarmDataPushResult = {
      id: newId('farmdata'),
      userId,
      accepted: true,
      receivedAt: new Date().toISOString(),
      linked: false
    };
    const link = (await this.accountLinks.find({ userId, activeOnly: true }))[0];
    if (link) {
      const record: FarmRecord = {
        id: newId('frec'),
        linkId: link.id,
        recordType: 'partner_push',
        // The push id is the replay dedupe key (UNIQUE(link_id, type, external_id)).
        externalId: result.id,
        payload,
        source: 'partner_api',
        observedAt: result.receivedAt,
        syncedAt: result.receivedAt
      };
      await this.farmRecords.upsertMany([record]);
      result.linked = true;
      result.farmRecordId = record.id;
    } else {
      await this.inboundEvents.ingest({
        id: newId('evt'),
        system: 'partner_api',
        eventType: 'farm_data.pending_link',
        dedupeKey: result.id,
        payload: { ...payload, userId, linkId: `pending-link:${userId}` },
        receivedAt: result.receivedAt
      });
      result.pendingLink = true;
    }
    await this.audit.record({
      actorId,
      action: 'partner.farm_data.received',
      entityType: 'user',
      entityId: userId,
      metadata: { partnerId, linked: result.linked }
    });
    await this.events.publish(
      'partner.farm_data.received',
      {
        ...result,
        assetCount: Array.isArray(payload.assets) ? payload.assets.length : 0
      },
      actorId
    );
    return result;
  }

  // --- Webhook subscription management -------------------------------------

  /**
   * Creates a webhook subscription scoped to the caller's bound partner
   * (Stage 27 WP-G3): the token's partnerId is authoritative (never
   * caller-supplied in the body), and crossTenant stays false — platform
   * cross-tenant receivers are operator-managed, not API-settable.
   */
  async createWebhookSubscription(
    clientId: string,
    input: { eventTypes: string[]; targetUrl: string; secret: string },
    partnerId?: string
  ): Promise<WebhookSubscription> {
    const invalid = input.eventTypes.filter(
      (type) => !PARTNER_EVENT_TYPES.includes(type as PartnerEventType)
    );
    if (invalid.length > 0) {
      throw new ForbiddenException(
        `Unknown event type(s): ${invalid.join(', ')}. Supported: ${PARTNER_EVENT_TYPES.join(', ')}`
      );
    }
    return this.subscriptions.create({
      id: newId('whsub'),
      clientId,
      eventTypes: input.eventTypes,
      targetUrl: input.targetUrl,
      secret: input.secret,
      status: 'active',
      partnerId,
      crossTenant: false,
      createdAt: new Date().toISOString()
    });
  }

  async webhookSubscriptionsFor(clientId: string): Promise<PublicWebhookSubscription[]> {
    const owned = await this.subscriptions.find({ clientId });
    // Secrets are delivery-time material; never echo them on reads.
    return owned.map(({ secret: _secret, ...rest }) => rest);
  }

  async removeWebhookSubscription(id: string, clientId: string): Promise<boolean> {
    const subscription = await this.subscriptions.getById(id);
    if (subscription.clientId !== clientId) {
      throw new ForbiddenException('Webhook subscription belongs to a different client');
    }
    return this.subscriptions.remove(id);
  }
}
