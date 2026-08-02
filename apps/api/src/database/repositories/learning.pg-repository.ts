import type pg from 'pg';
import type { Certificate, Course, Enrolment } from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  ilike,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { certificateMapper, courseMapper, enrolmentMapper } from '../pg/row-mappers.js';
import type { CertificateCriteria, CertificateRepository } from './certificate.repository.js';
import type { CourseCriteria, CourseRepository } from './course.repository.js';
import type { EnrolmentCriteria, EnrolmentRepository } from './enrolment.repository.js';

export function courseCriteriaSql(criteria: CourseCriteria): WhereClause {
  return composeWhere(
    eq('category', criteria.category),
    eq('level', criteria.level),
    eq('language', criteria.language),
    ilike('title', criteria.q)
  );
}

export class PgCourseRepository
  extends PgRepositoryBase<Course, CourseCriteria>
  implements CourseRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'learning.courses', mapper: courseMapper, criteria: courseCriteriaSql });
  }
}

export function enrolmentCriteriaSql(criteria: EnrolmentCriteria): WhereClause {
  return composeWhere(
    eq('user_id', criteria.userId),
    eq('course_id', criteria.courseId),
    eq('status', criteria.status)
  );
}

export class PgEnrolmentRepository
  extends PgRepositoryBase<Enrolment, EnrolmentCriteria>
  implements EnrolmentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'learning.enrolments',
      mapper: enrolmentMapper,
      criteria: enrolmentCriteriaSql
    });
  }

  async countCompleted(): Promise<number> {
    return this.count({ status: 'completed' });
  }

  async findByUserAndCourse(userId: string, courseId: string): Promise<Enrolment | undefined> {
    return this.findOne({ userId, courseId });
  }

  /** Enrolment update + certificate insert in one transaction (plan §10.15). */
  async updateWithCertificate(
    id: string,
    patch: Partial<Enrolment>,
    certificate?: Certificate
  ): Promise<Enrolment> {
    if (!certificate) {
      return this.update(id, patch);
    }
    return this.withTransaction(async (client) => {
      const row = enrolmentMapper.toRow(patch as Enrolment);
      const columns = Object.keys(row).filter((column) => column !== 'id');
      const result =
        columns.length > 0
          ? await client.query(
              `UPDATE learning.enrolments
                  SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')}
                WHERE id = $1 RETURNING ${enrolmentMapper.columns.join(', ')}`,
              [id, ...columns.map((column) => row[column])]
            )
          : await client.query(
              `SELECT ${enrolmentMapper.columns.join(', ')} FROM learning.enrolments WHERE id = $1`,
              [id]
            );
      const certRow = certificateMapper.toRow(certificate);
      const certColumns = Object.keys(certRow);
      await client.query(
        `INSERT INTO learning.certificates (${certColumns.join(', ')})
         VALUES (${certColumns.map((_, i) => `$${i + 1}`).join(', ')})`,
        certColumns.map((column) => certRow[column])
      );
      return enrolmentMapper.fromRow(result.rows[0]);
    });
  }
}

export function certificateCriteriaSql(criteria: CertificateCriteria): WhereClause {
  return composeWhere(
    eq('user_id', criteria.userId),
    eq('verification_code', criteria.verificationCode)
  );
}

export class PgCertificateRepository
  extends PgRepositoryBase<Certificate, CertificateCriteria>
  implements CertificateRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'learning.certificates',
      mapper: certificateMapper,
      criteria: certificateCriteriaSql
    });
  }

  /** NYFN-CERT-YYYY-#### from the DB counter table (UPDATE … RETURNING). */
  async allocateVerificationCode(): Promise<string> {
    const year = new Date().getFullYear();
    const result = await this.pool.query(
      `INSERT INTO learning.certificate_counters (year, next) VALUES ($1, 2)
       ON CONFLICT (year) DO UPDATE SET next = learning.certificate_counters.next + 1
       RETURNING next - 1 AS seq`,
      [year]
    );
    return `NYFN-CERT-${year}-${String(result.rows[0].seq as number).padStart(4, '0')}`;
  }
}

export function createPgCourseRepository(pool: pg.Pool): PgCourseRepository {
  return new PgCourseRepository(pool);
}

export function createPgEnrolmentRepository(pool: pg.Pool): PgEnrolmentRepository {
  return new PgEnrolmentRepository(pool);
}

export function createPgCertificateRepository(pool: pg.Pool): PgCertificateRepository {
  return new PgCertificateRepository(pool);
}
