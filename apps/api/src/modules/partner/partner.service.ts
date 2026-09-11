import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { ApplicationStatus, Opportunity, User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { PARTNER_MEMBER_REPOSITORY } from '../../database/persistence.tokens.js';
import type { PartnerMemberRepository } from '../../database/repositories/partner-member.repository.js';
import { LearningService } from '../learning/learning.service.js';
import {
  OpportunitiesService,
  type CreateOpportunityInput
} from '../opportunities/opportunities.service.js';
import { UsersService } from '../users/users.service.js';

export interface PartnerImpactReport {
  partnerId: string;
  generatedAt: string;
  programmes: number;
  applications: Record<ApplicationStatus, number>;
  participants: number;
  completedTrainings: number;
}

@Injectable()
export class PartnerService {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly learning: LearningService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(PARTNER_MEMBER_REPOSITORY) private readonly members: PartnerMemberRepository
  ) {}

  /**
   * Tenant binding (Stage 24, audit A2-1): the `partner` role alone never
   * authorises acting on an arbitrary `:partnerId`. Admins are unrestricted;
   * every other caller must hold an admin-granted membership row binding
   * their user id to the requested partner organisation (fail closed: no
   * membership row ⇒ 403).
   */
  async assertPartnerAccess(actor: User, partnerId: string): Promise<void> {
    if (actor.roles.includes('admin')) {
      return;
    }
    const membership = await this.members.findOne({ userId: actor.id, partnerId });
    if (!membership) {
      throw new ForbiddenException(
        `Caller is not a registered member of partner organisation '${partnerId}'`
      );
    }
  }

  async programmes(actor: User, partnerId: string): Promise<Opportunity[]> {
    await this.assertPartnerAccess(actor, partnerId);
    return this.opportunities.opportunitiesForPartner(partnerId);
  }

  async createProgramme(
    actor: User,
    partnerId: string,
    input: Omit<CreateOpportunityInput, 'partnerId'>
  ): Promise<Opportunity> {
    await this.assertPartnerAccess(actor, partnerId);
    const created = await this.opportunities.create({ ...input, partnerId });
    // Audit attribution (Stage 24, audit A2-4): the actor is the verified
    // caller, never the partnerId path slug (which is metadata instead).
    await this.audit.record({
      actorId: actor.id,
      action: 'partner.programme.created',
      entityType: 'opportunity',
      entityId: created.id,
      metadata: { title: created.title, partnerId }
    });
    return created;
  }

  /** Users who applied to any of the partner's programmes. */
  async participants(actor: User, partnerId: string): Promise<User[]> {
    await this.assertPartnerAccess(actor, partnerId);
    // TODO(phase-2): collapse the per-user lookups into a single JOIN (N+1).
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    const seen = new Set<string>();
    const participants: User[] = [];
    for (const application of applications) {
      if (seen.has(application.userId)) continue;
      seen.add(application.userId);
      const user = await this.users.findById(application.userId);
      if (user) participants.push(user);
    }
    return participants;
  }

  async impactReport(actor: User, partnerId: string): Promise<PartnerImpactReport> {
    await this.assertPartnerAccess(actor, partnerId);
    const applications = await this.opportunities.applicationsForPartner(partnerId);
    const byStatus: Record<ApplicationStatus, number> = {
      submitted: 0,
      under_review: 0,
      successful: 0,
      unsuccessful: 0,
      withdrawn: 0
    };
    for (const application of applications) {
      byStatus[application.status] += 1;
    }
    const participants = await this.participants(actor, partnerId);
    let completedTrainings = 0;
    for (const user of participants) {
      const enrolments = await this.learning.enrolmentsForUser(user.id);
      completedTrainings += enrolments.filter((e) => e.status === 'completed').length;
    }
    const report: PartnerImpactReport = {
      partnerId,
      generatedAt: new Date().toISOString(),
      programmes: (await this.opportunities.opportunitiesForPartner(partnerId)).length,
      applications: byStatus,
      participants: participants.length,
      completedTrainings
    };
    await this.audit.record({
      actorId: actor.id,
      action: 'partner.report.generated',
      entityType: 'partner',
      entityId: partnerId
    });
    await this.events.publish('partner.report.generated', { partnerId }, actor.id);
    return report;
  }
}
