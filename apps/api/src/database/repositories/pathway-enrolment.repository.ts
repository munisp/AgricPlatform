import type { PathwayEnrolment, PathwayEnrolmentStatus, StageProgress } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface PathwayEnrolmentCriteria {
  templateId?: string;
  userId?: string;
  status?: PathwayEnrolmentStatus;
}

export type PathwayEnrolmentRepository = AsyncRepository<PathwayEnrolment, PathwayEnrolmentCriteria>;

export function pathwayEnrolmentMatcher(
  criteria: PathwayEnrolmentCriteria
): (enrolment: PathwayEnrolment) => boolean {
  return (enrolment) =>
    (!criteria.templateId || enrolment.templateId === criteria.templateId) &&
    (!criteria.userId || enrolment.userId === criteria.userId) &&
    (!criteria.status || enrolment.status === criteria.status);
}

export class InMemoryPathwayEnrolmentRepository
  extends InMemoryRepository<PathwayEnrolment, PathwayEnrolmentCriteria>
  implements PathwayEnrolmentRepository
{
  constructor(seed: readonly PathwayEnrolment[] = []) {
    super(seed, pathwayEnrolmentMatcher);
  }
}

export interface StageProgressCriteria {
  enrolmentId?: string;
  stageId?: string;
}

export type StageProgressRepository = AsyncRepository<StageProgress, StageProgressCriteria>;

export function stageProgressMatcher(criteria: StageProgressCriteria): (progress: StageProgress) => boolean {
  return (progress) =>
    (!criteria.enrolmentId || progress.enrolmentId === criteria.enrolmentId) &&
    (!criteria.stageId || progress.stageId === criteria.stageId);
}

export class InMemoryStageProgressRepository
  extends InMemoryRepository<StageProgress, StageProgressCriteria>
  implements StageProgressRepository
{
  constructor(seed: readonly StageProgress[] = []) {
    super(seed, stageProgressMatcher);
  }
}

export function createInMemoryPathwayEnrolmentRepository(): InMemoryPathwayEnrolmentRepository {
  return new InMemoryPathwayEnrolmentRepository();
}

export function createInMemoryStageProgressRepository(): InMemoryStageProgressRepository {
  return new InMemoryStageProgressRepository();
}
