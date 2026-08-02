import type { ApiListResponse, CohortStatus, ProgrammeCohort, ProgrammeType } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ProgrammeCohortCriteria {
  programmeType?: ProgrammeType;
  status?: CohortStatus;
}

export interface ProgrammeCohortRepository
  extends AsyncRepository<ProgrammeCohort, ProgrammeCohortCriteria> {
  searchPage(
    criteria: ProgrammeCohortCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<ProgrammeCohort>>;
}

export function programmeCohortMatcher(
  criteria: ProgrammeCohortCriteria
): (cohort: ProgrammeCohort) => boolean {
  return (cohort) =>
    (!criteria.programmeType || cohort.programmeType === criteria.programmeType) &&
    (!criteria.status || cohort.status === criteria.status);
}

export class InMemoryProgrammeCohortRepository
  extends InMemoryRepository<ProgrammeCohort, ProgrammeCohortCriteria>
  implements ProgrammeCohortRepository
{
  constructor(seed: readonly ProgrammeCohort[] = []) {
    super(seed, programmeCohortMatcher);
  }
}

export function createInMemoryProgrammeCohortRepository(): InMemoryProgrammeCohortRepository {
  return new InMemoryProgrammeCohortRepository();
}
