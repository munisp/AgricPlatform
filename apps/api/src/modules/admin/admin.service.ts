import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PlatformMetric, User, UserRole } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { OutboxSweeperService, type OutboxSweepResult } from '../../core/outbox-sweeper.service.js';
import { AUTH_SESSION_REPOSITORY, CREDIT_PROFILE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { AuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import type { CreditProfileRepository } from '../../database/repositories/credit-profile.repository.js';
import type { OutboxRecord } from '../../database/repositories/outbox.repository.js';
import type { AccountStatus } from '../../database/repositories/user.repository.js';
import { assertNoSeedPlatformMetrics, composePlatformMetrics } from '../analytics/platform-metrics.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { CommunityService } from '../community/community.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';

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
    // Optional: a missing KPI source degrades to a labelled seed fixture
    // (refused in production), never a fabricated live number.
    @Optional() private readonly chapters?: ChaptersService,
    @Optional() @Inject(CREDIT_PROFILE_REPOSITORY) private readonly creditProfiles?: CreditProfileRepository
  ) {}

  async listUsers(role?: UserRole): Promise<AdminUserView[]> {
    const page = await this.users.list({ role, page: 1, pageSize: 100 });
    return Promise.all(
      page.data.map(async (user) => ({ user, accountStatus: await this.users.statusFor(user.id) }))
    );
  }

  async setRoles(userId: string, roles: UserRole[], actorId: string): Promise<AdminUserView> {
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

  /** Tamper-evidence check over the audit hash chain (observability plan §A.6). */
  async verifyAuditLog(range?: { fromId?: string; toId?: string }) {
    return this.audit.verify(range);
  }

  /** Wave P: one outbox sweeper pass (retries + dead-lettering). */
  async sweepOutbox(): Promise<OutboxSweepResult> {
    return this.outboxSweeper.sweep();
  }

  /** Wave P: dead-lettered outbox rows awaiting operator action. */
  async outboxDeadLetters(): Promise<OutboxRecord[]> {
    return this.outboxSweeper.deadLetters();
  }

  async eventOutbox(): Promise<DomainEvent[]> {
    return this.domainEvents.listOutbox();
  }
}
