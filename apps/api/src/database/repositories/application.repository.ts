import type { ApplicationStatus, OpportunityApplication } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedApplications } from '../seed-data.js';
import type { OpportunityRepository } from './opportunity.repository.js';

export interface ApplicationCriteria {
  userId?: string;
  opportunityId?: string;
  status?: ApplicationStatus;
}

export interface ApplicationRepository
  extends AsyncRepository<OpportunityApplication, ApplicationCriteria> {
  /** Applications to any opportunity owned by the partner (SQL JOIN). */
  findForPartner(partnerId: string): Promise<OpportunityApplication[]>;
  /** The user's non-withdrawn application for an opportunity, if any. */
  findActive(
    opportunityId: string,
    userId: string
  ): Promise<OpportunityApplication | undefined>;
}

export function applicationMatcher(
  criteria: ApplicationCriteria
): (application: OpportunityApplication) => boolean {
  return (application) =>
    (!criteria.userId || application.userId === criteria.userId) &&
    (!criteria.opportunityId || application.opportunityId === criteria.opportunityId) &&
    (!criteria.status || application.status === criteria.status);
}

export class InMemoryApplicationRepository
  extends InMemoryRepository<OpportunityApplication, ApplicationCriteria>
  implements ApplicationRepository
{
  constructor(
    seed: readonly OpportunityApplication[] = [],
    private readonly opportunities?: OpportunityRepository
  ) {
    super(seed, applicationMatcher);
  }

  async findForPartner(partnerId: string): Promise<OpportunityApplication[]> {
    if (!this.opportunities) {
      throw new Error('findForPartner requires the opportunity repository lookup');
    }
    const owned = new Set(
      (await this.opportunities.findByPartner(partnerId)).map((opportunity) => opportunity.id)
    );
    return (await this.all()).filter((application) => owned.has(application.opportunityId));
  }

  async findActive(
    opportunityId: string,
    userId: string
  ): Promise<OpportunityApplication | undefined> {
    return (await this.find({ opportunityId, userId })).find(
      (application) => application.status !== 'withdrawn'
    );
  }
}

export function createInMemoryApplicationRepository(
  opportunities?: OpportunityRepository
): InMemoryApplicationRepository {
  return new InMemoryApplicationRepository(seedApplications, opportunities);
}
