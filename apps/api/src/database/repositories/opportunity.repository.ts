import type { ApiListResponse, Opportunity } from '@agric-platform/shared';
import { opportunityMatchesProfile, seedOpportunities } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface OpportunityCriteria {
  state?: string;
  valueChain?: string;
  type?: Opportunity['type'];
  active?: boolean;
  /** Only opportunities whose deadline is on/after this ISO date (YYYY-MM-DD). */
  deadlineFrom?: string;
}

export interface OpportunityRepository extends AsyncRepository<Opportunity, OpportunityCriteria> {
  /**
   * Profile-match recommendation with empty-array match-all semantics
   * (plan §2.5.1): an opportunity matches when its states list is empty or
   * contains the profile state, AND its value chains list is empty or
   * intersects the profile value chains. Only active postings match.
   */
  findRecommendedForProfile(
    profileState: string | undefined,
    profileValueChains: string[]
  ): Promise<Opportunity[]>;
  findByPartner(partnerId: string): Promise<Opportunity[]>;
  /**
   * Pagination pushed into SQL on the pg driver (LIMIT/OFFSET + COUNT).
   * Public/list paths must use this instead of find()+slice (V-72).
   */
  searchPage(
    criteria: OpportunityCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<Opportunity>>;
}

export function opportunityMatcher(
  criteria: OpportunityCriteria
): (opportunity: Opportunity) => boolean {
  return (opportunity) =>
    (criteria.active === undefined || opportunity.isActive === criteria.active) &&
    (!criteria.type || opportunity.type === criteria.type) &&
    (!criteria.state || opportunity.states.includes(criteria.state)) &&
    (!criteria.valueChain || opportunity.valueChains.includes(criteria.valueChain)) &&
    (!criteria.deadlineFrom || opportunity.deadline >= criteria.deadlineFrom);
}

export class InMemoryOpportunityRepository
  extends InMemoryRepository<Opportunity, OpportunityCriteria>
  implements OpportunityRepository
{
  constructor(seed: readonly Opportunity[] = []) {
    super(seed, opportunityMatcher);
  }

  async findRecommendedForProfile(
    profileState: string | undefined,
    profileValueChains: string[]
  ): Promise<Opportunity[]> {
    return (await this.all()).filter(
      (opportunity) =>
        opportunity.isActive &&
        opportunityMatchesProfile({
          opportunityStates: opportunity.states,
          opportunityValueChains: opportunity.valueChains,
          profileState,
          profileValueChains
        })
    );
  }

  async findByPartner(partnerId: string): Promise<Opportunity[]> {
    return (await this.all()).filter((opportunity) => opportunity.partnerId === partnerId);
  }
}

export function createInMemoryOpportunityRepository(): InMemoryOpportunityRepository {
  return new InMemoryOpportunityRepository(seedOpportunities);
}
