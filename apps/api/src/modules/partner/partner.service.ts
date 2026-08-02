import { Injectable } from '@nestjs/common';
import type { ApplicationStatus, Opportunity, User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
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
    private readonly events: DomainEventsService
  ) {}

  async programmes(partnerId: string): Promise<Opportunity[]> {
    return this.opportunities.opportunitiesForPartner(partnerId);
  }

  async createProgramme(
    partnerId: string,
    input: Omit<CreateOpportunityInput, 'partnerId'>
  ): Promise<Opportunity> {
    const created = await this.opportunities.create({ ...input, partnerId });
    await this.audit.record({
      actorId: partnerId,
      action: 'partner.programme.created',
      entityType: 'opportunity',
      entityId: created.id,
      metadata: { title: created.title }
    });
    return created;
  }

  /** Users who applied to any of the partner's programmes. */
  async participants(partnerId: string): Promise<User[]> {
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

  async impactReport(partnerId: string): Promise<PartnerImpactReport> {
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
    const participants = await this.participants(partnerId);
    let completedTrainings = 0;
    for (const user of participants) {
      const enrolments = await this.learning.enrolmentsForUser(user.id);
      completedTrainings += enrolments.filter((e) => e.status === 'completed').length;
    }
    const report: PartnerImpactReport = {
      partnerId,
      generatedAt: new Date().toISOString(),
      programmes: (await this.programmes(partnerId)).length,
      applications: byStatus,
      participants: participants.length,
      completedTrainings
    };
    await this.audit.record({
      actorId: partnerId,
      action: 'partner.report.generated',
      entityType: 'partner',
      entityId: partnerId
    });
    await this.events.publish('partner.report.generated', { partnerId }, partnerId);
    return report;
  }
}
