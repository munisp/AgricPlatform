import type { MilestoneProgress, MilestoneProgressStatus, ProgrammeMilestone } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ProgrammeMilestoneCriteria {
  cohortId?: string;
}

export type ProgrammeMilestoneRepository = AsyncRepository<
  ProgrammeMilestone,
  ProgrammeMilestoneCriteria
>;

export function programmeMilestoneMatcher(
  criteria: ProgrammeMilestoneCriteria
): (milestone: ProgrammeMilestone) => boolean {
  return (milestone) => !criteria.cohortId || milestone.cohortId === criteria.cohortId;
}

export class InMemoryProgrammeMilestoneRepository
  extends InMemoryRepository<ProgrammeMilestone, ProgrammeMilestoneCriteria>
  implements ProgrammeMilestoneRepository
{
  constructor(seed: readonly ProgrammeMilestone[] = []) {
    super(seed, programmeMilestoneMatcher);
  }
}

export interface MilestoneProgressCriteria {
  milestoneId?: string;
  userId?: string;
  status?: MilestoneProgressStatus;
}

export type MilestoneProgressRepository = AsyncRepository<MilestoneProgress, MilestoneProgressCriteria>;

export function milestoneProgressMatcher(
  criteria: MilestoneProgressCriteria
): (progress: MilestoneProgress) => boolean {
  return (progress) =>
    (!criteria.milestoneId || progress.milestoneId === criteria.milestoneId) &&
    (!criteria.userId || progress.userId === criteria.userId) &&
    (!criteria.status || progress.status === criteria.status);
}

export class InMemoryMilestoneProgressRepository
  extends InMemoryRepository<MilestoneProgress, MilestoneProgressCriteria>
  implements MilestoneProgressRepository
{
  constructor(seed: readonly MilestoneProgress[] = []) {
    super(seed, milestoneProgressMatcher);
  }
}

export function createInMemoryProgrammeMilestoneRepository(): InMemoryProgrammeMilestoneRepository {
  return new InMemoryProgrammeMilestoneRepository();
}

export function createInMemoryMilestoneProgressRepository(): InMemoryMilestoneProgressRepository {
  return new InMemoryMilestoneProgressRepository();
}
