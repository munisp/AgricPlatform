import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  SELF_REGISTRATION_ROLES,
  type ApiListResponse,
  type AuditAnchor,
  type LanguageCode,
  type PlatformMetric,
  type User,
  type UserRole
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditAnchorService } from '../../core/audit-anchor.service.js';
import { AuditService, type AuditVerification } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { OutboxSweeperService, type OutboxSweepResult } from '../../core/outbox-sweeper.service.js';
import {
  AUTH_SESSION_REPOSITORY,
  CREDIT_PROFILE_REPOSITORY,
  PARTNER_MEMBER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import type {
  PartnerMember,
  PartnerMemberRepository
} from '../../database/repositories/partner-member.repository.js';
import type { CreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import type { OutboxRecord } from '../../database/repositories/outbox.repository.js';
import type { AccountStatus } from '../../database/repositories/user.repository.js';
import { assertNoSeedPlatformMetrics, composePlatformMetrics } from '../analytics/platform-metrics.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { CommunityService } from '../community/community.service.js';
import { FinanceService } from '../finance/finance.service.js';
import {
  IntegrationsService,
  type WebhookReprocessResult
} from '../integrations/integrations.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import {
  EscrowExpirySweeperService,
  type EscrowExpirySweepResult
} from '../sweepers/escrow-expiry-sweeper.service.js';
import {
  VoucherStuckSweeperService,
  type VoucherStuckSweepResult
} from '../sweepers/voucher-stuck-sweeper.service.js';
import { UsersService } from '../users/users.service.js';
import { PartnerAuthService } from '../partner-api/partner-auth.service.js';
import type { PartnerClient } from '../../database/repositories/partner-api.repository.js';

export type { AccountStatus };

export interface AdminUserView {
  user: User;
  accountStatus: AccountStatus;
}

export interface ReviewQueue {
  flaggedTopics: number;
  pendingDocuments: number;
  pendingApplications: number;
  items: Array<{ type: string; id: string; summary: string }>;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly community: CommunityService,
    private readonly finance: FinanceService,
    private readonly opportunities: OpportunitiesService,
    private readonly learning: LearningService,
    private readonly marketplace: MarketplaceService,
    private readonly outboxSweeper: OutboxSweeperService,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(PARTNER_MEMBER_REPOSITORY) private readonly partnerMembers: PartnerMemberRepository,
    // Optional: a missing KPI source degrades to a labelled seed fixture
    // (refused in production), never a fabricated live number.
    @Optional() private readonly chapters?: ChaptersService,
    @Optional() @Inject(CREDIT_PROFILE_REPOSITORY) private readonly creditProfiles?: CreditProfileRepository,
    // Webhook crash-recovery reprocessor (audit C2). Optional only so bare
    // unit-test constructions keep working; AdminModule imports
    // IntegrationsModule at runtime.
    @Optional() private readonly integrations?: IntegrationsService,
    // Stage 23: anchoring checkpoints. Optional so older tests/wiring keep
    // working; always provided in the deployed app via the global CoreModule.
    @Optional() private readonly auditAnchors?: AuditAnchorService,
    // WP-G12 money-state sweepers. Optional only so bare unit-test
    // constructions keep working; AdminModule imports SweepersModule at
    // runtime.
    @Optional() private readonly escrowExpirySweeper?: EscrowExpirySweeperService,
    @Optional() private readonly voucherStuckSweeper?: VoucherStuckSweeperService,
    // OB-17b: partner-organisation client provisioning. Optional so bare
    // unit-test constructions keep working; AdminModule imports
    // PartnerApiModule at runtime.
    @Optional() private readonly partnerAuth?: PartnerAuthService
  ) {}

  /**
   * Admin user directory — real pagination (V-72/L-14): the previous
   * hard-coded page 1 / 100 silently truncated the directory at 100 users.
   */
  async listUsers(
    role?: UserRole,
    page = 1,
    pageSize = 100
  ): Promise<ApiListResponse<AdminUserView>> {
    const result = await this.users.list({ role, page, pageSize });
    const data = await Promise.all(
      result.data.map(async (user) => ({
        user,
        accountStatus: await this.users.statusFor(user.id)
      }))
    );
    return { data, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  /**
   * OB-07: privileged roles (anything outside SELF_REGISTRATION_ROLES) may
   * only be granted to a target that is BOTH active and OTP-verified — a
   * privileged grant to an unverified or suspended/deceased account would
   * hand operational authority to an identity nobody has confirmed. Plain
   * self-registration roles may be granted to any active account.
   */
  async setRoles(userId: string, roles: UserRole[], actorId: string): Promise<AdminUserView> {
    const target = await this.users.getById(userId);
    const status = await this.users.statusFor(userId);
    const grantsPrivileged = roles.some(
      (role) => !(SELF_REGISTRATION_ROLES as readonly UserRole[]).includes(role)
    );
    if (status !== 'active') {
      throw new BadRequestException(
        `Roles cannot be granted to a ${status} account; reactivate the account first`
      );
    }
    if (grantsPrivileged && !target.isVerified) {
      throw new BadRequestException(
        'Privileged roles require an OTP-verified account; the user must complete phone verification first'
      );
    }
    const user = await this.users.setRoles(userId, roles);
    await this.audit.record({
      actorId,
      action: 'admin.user.roles_updated',
      entityType: 'user',
      entityId: userId,
      metadata: { roles }
    });
    await this.domainEvents.publish('identity.user.roles_updated', { userId, roles }, actorId);
    return { user, accountStatus: await this.users.statusFor(userId) };
  }

  /**
   * OB-17a: admin-provisioned account. Created UNVERIFIED (isVerified=false,
   * kycTier tier_0) exactly like self-service registration — the user must
   * complete OTP verification on first login before privileged roles take
   * effect (OB-07 gates privileged grants on verification). Audited.
   */
  async createUser(
    input: {
      phone: string;
      fullName: string;
      roles: UserRole[];
      preferredLanguage: LanguageCode;
      email?: string;
    },
    actorId: string
  ): Promise<AdminUserView> {
    const user = await this.users.create(input);
    await this.audit.record({
      actorId,
      action: 'admin.user.created',
      entityType: 'user',
      entityId: user.id,
      metadata: { roles: user.roles, phone: user.phone }
    });
    await this.domainEvents.publish(
      'identity.user.created',
      { userId: user.id, roles: user.roles, provisionedBy: 'admin' },
      actorId
    );
    return { user, accountStatus: await this.users.statusFor(user.id) };
  }

  /**
   * OB-17b: partner-organisation provisioning — registers a partner API
   * client bound to ONE partner organisation slug (the `partners` tenant
   * entity, migration 010/051). Returns the plaintext client secret exactly
   * once; only the hash is persisted. Audited (secret never logged).
   */
  async registerPartnerClient(
    input: { name: string; scopes: string[]; partnerId: string; rateLimitPerMin?: number },
    actorId: string
  ): Promise<{ client: PartnerClient; clientSecret: string }> {
    if (!this.partnerAuth) {
      throw new ServiceUnavailableException('Partner client provisioning is not wired');
    }
    const issued = await this.partnerAuth.registerClient(input);
    await this.audit.record({
      actorId,
      action: 'admin.partner_client.registered',
      entityType: 'partner_client',
      entityId: issued.client.id,
      metadata: { clientId: issued.client.clientId, partnerId: issued.client.partnerId }
    });
    return issued;
  }

  /**
   * Partner tenant binding (Stage 24, audit A2-1): grants `userId` acting
   * rights on `/partner/:partnerId/*`. Idempotent; audited. Only meaningful
   * for accounts holding the `partner` role (the route guard enforces that).
   */
  async bindPartnerMember(userId: string, partnerId: string, actorId: string): Promise<PartnerMember> {
    await this.users.getById(userId);
    const existing = await this.partnerMembers.findOne({ userId, partnerId });
    if (existing) {
      return existing;
    }
    const member = await this.partnerMembers.create({
      id: newId('pmem'),
      userId,
      partnerId,
      createdBy: actorId,
      createdAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId,
      action: 'admin.partner_member.bound',
      entityType: 'partner_member',
      entityId: member.id,
      metadata: { userId, partnerId }
    });
    return member;
  }

  /** Revokes a partner tenant binding (audited); 404 when none exists. */
  async unbindPartnerMember(
    userId: string,
    partnerId: string,
    actorId: string
  ): Promise<{ removed: boolean }> {
    const existing = await this.partnerMembers.findOne({ userId, partnerId });
    if (!existing) {
      throw new NotFoundException(`No partner membership for ${userId} on ${partnerId}`);
    }
    await this.partnerMembers.remove(existing.id);
    await this.audit.record({
      actorId,
      action: 'admin.partner_member.unbound',
      entityType: 'partner_member',
      entityId: existing.id,
      metadata: { userId, partnerId }
    });
    return { removed: true };
  }

  /** Partner membership rows (operability for the tenant-binding surface). */
  async partnerMemberships(userId?: string): Promise<PartnerMember[]> {
    return this.partnerMembers.find({ userId });
  }

  async setStatus(userId: string, status: AccountStatus, actorId: string): Promise<AdminUserView> {
    await this.users.getById(userId);
    await this.users.setStatus(userId, status);
    if (status === 'suspended') {
      await this.users.setVerified(userId, false);
      // A suspension must take effect immediately: revoke every refresh-token
      // session family so no still-valid token can mint new access.
      await this.sessions.revokeAllForUser(userId, new Date().toISOString());
    }
    await this.audit.record({
      actorId,
      action: 'admin.user.status_changed',
      entityType: 'user',
      entityId: userId,
      metadata: { status }
    });
    await this.domainEvents.publish('identity.user.status_changed', { userId, status }, actorId);
    return { user: await this.users.getById(userId), accountStatus: status };
  }

  async setVerified(
    userId: string,
    isVerified: boolean,
    actorId: string
  ): Promise<AdminUserView> {
    const user = await this.users.setVerified(userId, isVerified);
    await this.audit.record({
      actorId,
      action: 'admin.user.verification_changed',
      entityType: 'user',
      entityId: userId,
      metadata: { isVerified }
    });
    return { user, accountStatus: await this.users.statusFor(userId) };
  }

  async reviewQueue(): Promise<ReviewQueue> {
    const [flags, pendingDocs, pendingApps] = await Promise.all([
      this.community.openFlags(),
      this.finance.listDocuments(undefined, 'uploaded'),
      this.opportunities.listApplications({ status: 'submitted' })
    ]);
    return {
      flaggedTopics: flags.length,
      pendingDocuments: pendingDocs.length,
      pendingApplications: pendingApps.length,
      items: [
        ...flags.map((f) => ({ type: 'flagged_topic', id: f.id, summary: f.reason })),
        ...pendingDocs.map((d) => ({ type: 'document', id: d.id, summary: `${d.kind}: ${d.fileName}` })),
        ...pendingApps.map((a) => ({ type: 'application', id: a.id, summary: a.notes ?? a.opportunityId }))
      ]
    };
  }

  /**
   * Platform KPIs: every entry is repository-computed (basis 'live'). The
   * hardcoded seed fixture is no longer served here; a KPI whose source is
   * not wired degrades to a labelled seed fixture and is refused in
   * production instead of passing off as a real number.
   */
  async kpis(): Promise<PlatformMetric[]> {
    const [members, chapters, courseCompletions, opportunities, marketplaceListings, creditProfiles] =
      await Promise.all([
        this.users.count(),
        this.chapters?.all(),
        this.learning.completionCount(),
        this.opportunities.list({ active: true, page: 1, pageSize: 1 }),
        this.marketplace.activeListingCount(),
        this.creditProfiles?.count()
      ]);
    const metrics = composePlatformMetrics({
      members,
      activeChapters: chapters?.filter((chapter) => chapter.active).length,
      courseCompletions,
      openOpportunities: opportunities.total,
      marketplaceListings,
      creditProfiles
    });
    assertNoSeedPlatformMetrics(metrics);
    return metrics;
  }

  async auditLog(actorId?: string, entityType?: string) {
    return this.audit.list({ actorId, entityType });
  }

  /**
   * Tamper-evidence check over the audit hash chain (observability plan
   * §A.6), extended with the Stage 23 anchoring checkpoints: the result
   * carries an `anchors` section (anchor-chain integrity + truncation-gap
   * detection against the latest anchor) and `valid` is the AND of the
   * event-chain and anchor checks. Fails LOUDLY with structured detail
   * (brokenAt / brokenAnchorAt / gap), never silently.
   */
  async verifyAuditLog(range?: { fromId?: string; toId?: string }): Promise<AuditVerification> {
    const chain = await this.audit.verify(range);
    if (!this.auditAnchors) {
      return chain;
    }
    const anchors = await this.auditAnchors.verifyAnchors();
    return { ...chain, valid: chain.valid && anchors.valid, anchors };
  }

  /** Stage 23: create an anchoring checkpoint over the current chain tip (on demand). */
  async createAuditAnchor(): Promise<AuditAnchor> {
    if (!this.auditAnchors) {
      throw new Error('audit anchoring is not wired in this deployment');
    }
    return this.auditAnchors.createAnchor();
  }

  /** Stage 23: list anchoring checkpoints in anchor-chain order. */
  async listAuditAnchors(): Promise<AuditAnchor[]> {
    return this.auditAnchors ? this.auditAnchors.listAnchors() : [];
  }

  /** Wave P: one outbox sweeper pass (retries + dead-lettering). */
  async sweepOutbox(): Promise<OutboxSweepResult> {
    return this.outboxSweeper.sweep();
  }

  /**
   * Webhook crash-recovery sweep (audit C2): re-drives recorded provider
   * webhooks whose processing never completed (dedupe insert succeeded but
   * the side effects failed). Same external-scheduler pattern as the outbox
   * sweep — POST /admin/webhooks/reprocess.
   */
  async reprocessWebhooks(): Promise<WebhookReprocessResult> {
    if (!this.integrations) {
      throw new ServiceUnavailableException(
        'IntegrationsService is not wired into the admin module'
      );
    }
    return this.integrations.reprocessUnprocessedWebhooks();
  }

  /**
   * WP-G12: one escrow-expiry sweeper pass (auto-refund of held escrows past
   * their deadline + resume of stuck release/refund drives). Same
   * external-scheduler pattern as the outbox sweep — the k8s CronJob fleet
   * (infra/k8s/cronjobs/) calls POST /admin/sweeps/escrow-expiry.
   */
  async sweepEscrowExpiry(): Promise<EscrowExpirySweepResult> {
    if (!this.escrowExpirySweeper) {
      throw new ServiceUnavailableException(
        'EscrowExpirySweeperService is not wired into the admin module'
      );
    }
    return this.escrowExpirySweeper.sweep();
  }

  /**
   * WP-G12: one stuck-voucher sweeper pass (expire due vouchers + recover
   * stuck VOIDING/REDEEMING claims). Invoked by the CronJob fleet via
   * POST /admin/sweeps/voucher-stuck.
   */
  async sweepVoucherStuck(): Promise<VoucherStuckSweepResult> {
    if (!this.voucherStuckSweeper) {
      throw new ServiceUnavailableException(
        'VoucherStuckSweeperService is not wired into the admin module'
      );
    }
    return this.voucherStuckSweeper.sweep();
  }

  /** Wave P: dead-lettered outbox rows awaiting operator action. */
  async outboxDeadLetters(): Promise<OutboxRecord[]> {
    return this.outboxSweeper.deadLetters();
  }

  /**
   * V-79: resurrect a dead-lettered outbox row (clears dead_lettered_at +
   * attempts; the next sweep re-delivers it). Audited, admin-only via the
   * controller.
   */
  async redriveOutboxDeadLetter(actorId: string, id: string): Promise<OutboxRecord> {
    const record = await this.outboxSweeper.redriveDeadLetter(id);
    await this.audit.record({
      actorId,
      action: 'admin.outbox_dead_letter_redriven',
      entityType: 'outbox',
      entityId: id,
      metadata: { eventName: record.event.name }
    });
    return record;
  }

  async eventOutbox(): Promise<DomainEvent[]> {
    return this.domainEvents.listOutbox();
  }
}
