import type { Certificate, Enrolment } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedEnrolments } from '../seed-data.js';
import type { CertificateRepository } from './certificate.repository.js';

export interface EnrolmentCriteria {
  userId?: string;
  courseId?: string;
  status?: Enrolment['status'];
}

export interface EnrolmentRepository extends AsyncRepository<Enrolment, EnrolmentCriteria> {
  countCompleted(): Promise<number>;
  findByUserAndCourse(userId: string, courseId: string): Promise<Enrolment | undefined>;
  /**
   * Progress update + certificate issuance as one atomic unit
   * (learning.enrolments + learning.certificates, plan §10 task 15).
   */
  updateWithCertificate(
    id: string,
    patch: Partial<Enrolment>,
    certificate?: Certificate
  ): Promise<Enrolment>;
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
  constructor(
    seed: readonly Enrolment[] = [],
    private readonly certificates?: CertificateRepository
  ) {
    super(seed, enrolmentMatcher);
  }

  async countCompleted(): Promise<number> {
    return this.count({ status: 'completed' });
  }

  async findByUserAndCourse(userId: string, courseId: string): Promise<Enrolment | undefined> {
    return this.findOne({ userId, courseId });
  }

  async updateWithCertificate(
    id: string,
    patch: Partial<Enrolment>,
    certificate?: Certificate
  ): Promise<Enrolment> {
    const updated = await this.update(id, patch);
    if (certificate) {
      await this.certificates?.create(certificate);
    }
    return updated;
  }
}

export function createInMemoryEnrolmentRepository(
  certificates?: CertificateRepository
): InMemoryEnrolmentRepository {
  return new InMemoryEnrolmentRepository(seedEnrolments, certificates);
}
