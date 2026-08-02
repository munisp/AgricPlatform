import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  ApiListResponse,
  ApplicationStatus,
  Opportunity,
  OpportunityApplication
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { paginate } from '../../common/pagination.js';
import {
  APPLICATION_REPOSITORY,
  OPPORTUNITY_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ApplicationRepository } from '../../database/repositories/application.repository.js';
import type {
  OpportunityCriteria,
  OpportunityRepository
} from '../../database/repositories/opportunity.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
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
  constructor(
    private readonly events: DomainEventsService,
    private readonly profiles: ProfilesService,
    @Inject(OPPORTUNITY_REPOSITORY) private readonly opportunities: OpportunityRepository,
    @Inject(APPLICATION_REPOSITORY) private readonly applications: ApplicationRepository
  ) {}

  async list(
    filter: OpportunityCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<Opportunity>> {
    const items = await this.opportunities.find({
      state: filter.state,
      valueChain: filter.valueChain,
      type: filter.type,
      active: filter.active
    });
    return paginate(items, filter.page, filter.pageSize);
  }

  async all(): Promise<Opportunity[]> {
    return this.opportunities.all();
  }

  async get(id: string): Promise<Opportunity> {
    return this.opportunities.getById(id);
  }

  async create(input: CreateOpportunityInput): Promise<Opportunity> {
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
    const created = await this.opportunities.create(opportunity);
    await this.events.publish('opportunity.posting.created', { opportunityId: created.id }, input.partnerId);
    return created;
  }

  async recommendedFor(userId: string): Promise<Opportunity[]> {
    const profile = await this.profiles.get(userId);
    return this.opportunities.findRecommendedForProfile(
      profile.location?.state,
      profile.valueChains
    );
  }

  async apply(
    opportunityId: string,
    userId: string,
    notes?: string
  ): Promise<OpportunityApplication> {
    const opportunity = await this.opportunities.getById(opportunityId);
    if (!opportunity.isActive) {
      throw new ConflictException('Opportunity is not accepting applications');
    }
    if (await this.applications.findActive(opportunityId, userId)) {
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
    const created = await this.applications.create(application);
    await this.events.publish(
      'opportunity.application.submitted',
      { applicationId: created.id, opportunityId },
      userId
    );
    return created;
  }

  async listApplications(filter: {
    userId?: string;
    opportunityId?: string;
    status?: ApplicationStatus;
  }): Promise<OpportunityApplication[]> {
    return this.applications.find({
      userId: filter.userId,
      opportunityId: filter.opportunityId,
      status: filter.status
    });
  }

  async getApplication(id: string): Promise<OpportunityApplication> {
    return this.applications.getById(id);
  }

  async setApplicationStatus(
    id: string,
    status: ApplicationStatus,
    actorId: string
  ): Promise<OpportunityApplication> {
    const updated = await this.applications.update(id, { status });
    await this.events.publish(
      'opportunity.application.status_changed',
      { applicationId: id, status },
      actorId
    );
    return updated;
  }

  async applicationsForPartner(partnerId: string): Promise<OpportunityApplication[]> {
    return this.applications.findForPartner(partnerId);
  }

  async opportunitiesForPartner(partnerId: string): Promise<Opportunity[]> {
    return this.opportunities.findByPartner(partnerId);
  }
}
