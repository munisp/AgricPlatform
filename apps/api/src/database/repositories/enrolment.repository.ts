import type { Enrolment } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedEnrolments } from '../seed-data.js';

export interface EnrolmentCriteria {
  userId?: string;
  courseId?: string;
  status?: Enrolment['status'];
}

export interface EnrolmentRepository extends AsyncRepository<Enrolment, EnrolmentCriteria> {
  countCompleted(): Promise<number>;
  findByUserAndCourse(userId: string, courseId: string): Promise<Enrolment | undefined>;
}

export function enrolmentMatcher(criteria: EnrolmentCriteria): (enrolment: Enrolment) => boolean {
  return (enrolment) =>
    (!criteria.userId || enrolment.userId === criteria.userId) &&
    (!criteria.courseId || enrolment.courseId === criteria.courseId) &&
    (!criteria.status || enrolment.status === criteria.status);
}

export class InMemoryEnrolmentRepository
  extends InMemoryRepository<Enrolment, EnrolmentCriteria>
  implements EnrolmentRepository
{
  constructor(seed: readonly Enrolment[] = []) {
    super(seed, enrolmentMatcher);
  }

  async countCompleted(): Promise<number> {
    return this.count({ status: 'completed' });
  }

  async findByUserAndCourse(userId: string, courseId: string): Promise<Enrolment | undefined> {
    return this.findOne({ userId, courseId });
  }
}

export function createInMemoryEnrolmentRepository(): InMemoryEnrolmentRepository {
  return new InMemoryEnrolmentRepository(seedEnrolments);
}
