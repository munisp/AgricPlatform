import type { ProgrammeEnrolment, ProgrammeEnrolmentStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ProgrammeEnrolmentCriteria {
  cohortId?: string;
  userId?: string;
  status?: ProgrammeEnrolmentStatus;
}

export type ProgrammeEnrolmentRepository = AsyncRepository<
  ProgrammeEnrolment,
  ProgrammeEnrolmentCriteria
>;

export function programmeEnrolmentMatcher(
  criteria: ProgrammeEnrolmentCriteria
): (enrolment: ProgrammeEnrolment) => boolean {
  return (enrolment) =>
    (!criteria.cohortId || enrolment.cohortId === criteria.cohortId) &&
    (!criteria.userId || enrolment.userId === criteria.userId) &&
    (!criteria.status || enrolment.status === criteria.status);
}

export class InMemoryProgrammeEnrolmentRepository
  extends InMemoryRepository<ProgrammeEnrolment, ProgrammeEnrolmentCriteria>
  implements ProgrammeEnrolmentRepository
{
  constructor(seed: readonly ProgrammeEnrolment[] = []) {
    super(seed, programmeEnrolmentMatcher);
  }
}

export function createInMemoryProgrammeEnrolmentRepository(): InMemoryProgrammeEnrolmentRepository {
  return new InMemoryProgrammeEnrolmentRepository();
}
