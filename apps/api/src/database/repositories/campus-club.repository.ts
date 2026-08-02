import type { CampusClub, CampusClubMembership } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface CampusClubCriteria {
  state?: string;
  institution?: string;
  isNyscCdsGroup?: boolean;
}

export type CampusClubRepository = AsyncRepository<CampusClub, CampusClubCriteria>;

export function campusClubMatcher(criteria: CampusClubCriteria): (club: CampusClub) => boolean {
  return (club) =>
    (!criteria.state || club.state === criteria.state) &&
    (!criteria.institution || club.institution === criteria.institution) &&
    (criteria.isNyscCdsGroup === undefined || club.isNyscCdsGroup === criteria.isNyscCdsGroup);
}

export class InMemoryCampusClubRepository
  extends InMemoryRepository<CampusClub, CampusClubCriteria>
  implements CampusClubRepository
{
  constructor(seed: readonly CampusClub[] = []) {
    super(seed, campusClubMatcher);
  }
}

export interface CampusClubMembershipCriteria {
  clubId?: string;
  userId?: string;
}

export type CampusClubMembershipRepository = AsyncRepository<
  CampusClubMembership,
  CampusClubMembershipCriteria
>;

export function campusClubMembershipMatcher(
  criteria: CampusClubMembershipCriteria
): (membership: CampusClubMembership) => boolean {
  return (membership) =>
    (!criteria.clubId || membership.clubId === criteria.clubId) &&
    (!criteria.userId || membership.userId === criteria.userId);
}

export class InMemoryCampusClubMembershipRepository
  extends InMemoryRepository<CampusClubMembership, CampusClubMembershipCriteria>
  implements CampusClubMembershipRepository
{
  constructor(seed: readonly CampusClubMembership[] = []) {
    super(seed, campusClubMembershipMatcher);
  }
}

export function createInMemoryCampusClubRepository(): InMemoryCampusClubRepository {
  return new InMemoryCampusClubRepository();
}

export function createInMemoryCampusClubMembershipRepository(): InMemoryCampusClubMembershipRepository {
  return new InMemoryCampusClubMembershipRepository();
}
