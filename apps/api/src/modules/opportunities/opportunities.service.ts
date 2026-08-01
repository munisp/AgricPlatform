import { ConflictException, Injectable } from '@nestjs/common';
import type {
  ApiListResponse,
  ApplicationStatus,
  Opportunity,
  OpportunityApplication
} from '@agric-platform/shared';
import { opportunityMatchesProfile, seedOpportunities } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { seedApplications } from '../../database/seed-data.js';
import { ProfilesService } from '../profiles/profiles.service.js';

export interface CreateOpportunityInput {
  title: string;
  type: Opportunity['type'];
  description: string;
  states?: string[];
  valueChains?: string[];
  eligibility?: string[];
  deadline: string;
  partnerId?: string;
}

@Injectable()
export class OpportunitiesService {
  private readonly opportunities = new InMemoryRepository<Opportunity>(seedOpportunities);
  private readonly applications = new InMemoryRepository<OpportunityApplication>(seedApplications);

  constructor(
    private readonly events: DomainEventsService,
    private readonly profiles: ProfilesService
  ) {}

  list(filter: {
    state?: string;
    valueChain?: string;
    type?: Opportunity['type'];
    active?: boolean;
    page?: number;
    pageSize?: number;
  }): ApiListResponse<Opportunity> {
    let items = this.opportunities.all();
    if (filter.active !== undefined) items = items.filter((o) => o.isActive === filter.active);
    if (filter.type) items = items.filter((o) => o.type === filter.type);
    if (filter.state) items = items.filter((o) => o.states.includes(filter.state as string));
    if (filter.valueChain) {
      items = items.filter((o) => o.valueChains.includes(filter.valueChain as string));
    }
    return paginate(items, filter.page, filter.pageSize);
  }

  all(): Opportunity[] {
    return this.opportunities.all();
  }

  get(id: string): Opportunity {
    return this.opportunities.getById(id);
  }

  create(input: CreateOpportunityInput): Opportunity {
    const opportunity: Opportunity = {
      id: newId('opp'),
      title: input.title,
      type: input.type,
      description: input.description,
      states: input.states ?? [],
      valueChains: input.valueChains ?? [],
      eligibility: input.eligibility ?? [],
      deadline: input.deadline,
      partnerId: input.partnerId,
      isActive: true
    };
    const created = this.opportunities.create(opportunity);
    this.events.publish('opportunity.posting.created', { opportunityId: created.id }, input.partnerId);
    return created;
  }

  recommendedFor(userId: string): Opportunity[] {
    const profile = this.profiles.get(userId);
    return this.opportunities.find(
      (o) =>
        o.isActive &&
        opportunityMatchesProfile({
          opportunityStates: o.states,
          opportunityValueChains: o.valueChains,
          profileState: profile.location?.state,
          profileValueChains: profile.valueChains
        })
    );
  }

  apply(opportunityId: string, userId: string, notes?: string): OpportunityApplication {
    const opportunity = this.opportunities.getById(opportunityId);
    if (!opportunity.isActive) {
      throw new ConflictException('Opportunity is not accepting applications');
    }
    const existing = this.applications.findOne(
      (a) => a.opportunityId === opportunityId && a.userId === userId && a.status !== 'withdrawn'
    );
    if (existing) {
      throw new ConflictException('User has already applied to this opportunity');
    }
    const application: OpportunityApplication = {
      id: newId('application'),
      opportunityId,
      userId,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      notes
    };
    const created = this.applications.create(application);
    this.events.publish(
      'opportunity.application.submitted',
      { applicationId: created.id, opportunityId },
      userId
    );
    return created;
  }

  listApplications(filter: {
    userId?: string;
    opportunityId?: string;
    status?: ApplicationStatus;
  }): OpportunityApplication[] {
    return this.applications.find(
      (a) =>
        (!filter.userId || a.userId === filter.userId) &&
        (!filter.opportunityId || a.opportunityId === filter.opportunityId) &&
        (!filter.status || a.status === filter.status)
    );
  }

  getApplication(id: string): OpportunityApplication {
    return this.applications.getById(id);
  }

  setApplicationStatus(id: string, status: ApplicationStatus, actorId: string): OpportunityApplication {
    const updated = this.applications.update(id, { status });
    this.events.publish(
      'opportunity.application.status_changed',
      { applicationId: id, status },
      actorId
    );
    return updated;
  }

  applicationsForPartner(partnerId: string): OpportunityApplication[] {
    const partnerOpportunityIds = new Set(
      this.opportunities.find((o) => o.partnerId === partnerId).map((o) => o.id)
    );
    return this.applications.find((a) => partnerOpportunityIds.has(a.opportunityId));
  }

  opportunitiesForPartner(partnerId: string): Opportunity[] {
    return this.opportunities.find((o) => o.partnerId === partnerId);
  }
}
