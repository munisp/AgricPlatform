import { Injectable } from '@nestjs/common';
import type { PlatformMetric, User, UserRole } from '@agric-platform/shared';
import { platformMetrics } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { CommunityService } from '../community/community.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';

export type AccountStatus = 'active' | 'suspended';

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
  /** Account status overlay; becomes a users.status column in PostgreSQL. */
  private readonly accountStatuses = new Map<string, AccountStatus>();

  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly domainEvents: DomainEventsService,
    private readonly community: CommunityService,
    private readonly finance: FinanceService,
    private readonly opportunities: OpportunitiesService,
    private readonly learning: LearningService,
    private readonly marketplace: MarketplaceService
  ) {}

  listUsers(role?: UserRole): AdminUserView[] {
    return this.users
      .list({ role, page: 1, pageSize: 100 })
      .data.map((user) => ({ user, accountStatus: this.statusFor(user.id) }));
  }

  setRoles(userId: string, roles: UserRole[], actorId: string): AdminUserView {
    const user = this.users.setRoles(userId, roles);
    this.audit.record({
      actorId,
      action: 'admin.user.roles_updated',
      entityType: 'user',
      entityId: userId,
      metadata: { roles }
    });
    this.domainEvents.publish('identity.user.roles_updated', { userId, roles }, actorId);
    return { user, accountStatus: this.statusFor(userId) };
  }

  setStatus(userId: string, status: AccountStatus, actorId: string): AdminUserView {
    const user = this.users.getById(userId);
    this.accountStatuses.set(userId, status);
    if (status === 'suspended') {
      this.users.setVerified(userId, false);
    }
    this.audit.record({
      actorId,
      action: 'admin.user.status_changed',
      entityType: 'user',
      entityId: userId,
      metadata: { status }
    });
    this.domainEvents.publish('identity.user.status_changed', { userId, status }, actorId);
    return { user: this.users.getById(userId), accountStatus: status };
  }

  setVerified(userId: string, isVerified: boolean, actorId: string): AdminUserView {
    const user = this.users.setVerified(userId, isVerified);
    this.audit.record({
      actorId,
      action: 'admin.user.verification_changed',
      entityType: 'user',
      entityId: userId,
      metadata: { isVerified }
    });
    return { user, accountStatus: this.statusFor(userId) };
  }

  reviewQueue(): ReviewQueue {
    const flags = this.community.openFlags();
    const pendingDocs = this.finance.listDocuments(undefined, 'uploaded');
    const pendingApps = this.opportunities.listApplications({ status: 'submitted' });
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

  kpis(): PlatformMetric[] {
    return [
      ...platformMetrics,
      { key: 'registered_users', label: 'Registered users (live)', value: this.users.count() },
      {
        key: 'course_completions_live',
        label: 'Course completions (live)',
        value: this.learning.completionCount()
      },
      {
        key: 'active_listings_live',
        label: 'Active listings (live)',
        value: this.marketplace.activeListingCount()
      }
    ];
  }

  auditLog(actorId?: string, entityType?: string) {
    return this.audit.list({ actorId, entityType });
  }

  eventOutbox(): DomainEvent[] {
    return this.domainEvents.listOutbox();
  }

  private statusFor(userId: string): AccountStatus {
    return this.accountStatuses.get(userId) ?? 'active';
  }
}
