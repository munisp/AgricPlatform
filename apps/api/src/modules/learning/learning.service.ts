import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ApiListResponse, Certificate, Course, Enrolment, LanguageCode } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  CERTIFICATE_REPOSITORY,
  COURSE_REPOSITORY,
  ENROLMENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CertificateRepository } from '../../database/repositories/certificate.repository.js';
import type {
  CourseCriteria,
  CourseRepository
} from '../../database/repositories/course.repository.js';
import type { EnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';

export interface CreateCourseInput {
  title: string;
  category: string;
  level: Course['level'];
  durationMinutes: number;
  language: LanguageCode;
  offlineAvailable?: boolean;
}

export interface CertificateVerification {
  valid: boolean;
  certificate?: Certificate;
  courseTitle?: string;
  learnerName?: string;
}

@Injectable()
export class LearningService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(COURSE_REPOSITORY) private readonly courses: CourseRepository,
    @Inject(ENROLMENT_REPOSITORY) private readonly enrolments: EnrolmentRepository,
    @Inject(CERTIFICATE_REPOSITORY) private readonly certificates: CertificateRepository
  ) {}

  async listCourses(
    filter: CourseCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<Course>> {
    return this.courses.searchPage(
      {
        category: filter.category,
        level: filter.level,
        language: filter.language,
        q: filter.q
      },
      filter.page,
      filter.pageSize
    );
  }

  async allCourses(): Promise<Course[]> {
    return this.courses.all();
  }

  async getCourse(id: string): Promise<Course> {
    return this.courses.getById(id);
  }

  async createCourse(input: CreateCourseInput): Promise<Course> {
    const course: Course = {
      id: newId('course'),
      title: input.title,
      category: input.category,
      level: input.level,
      durationMinutes: input.durationMinutes,
      language: input.language,
      enrolmentCount: 0,
      offlineAvailable: input.offlineAvailable ?? false
    };
    const created = await this.courses.create(course);
    await this.events.publish('learning.course.created', { courseId: created.id });
    return created;
  }

  async enrol(courseId: string, userId: string): Promise<Enrolment> {
    const course = await this.courses.getById(courseId);
    if (await this.enrolments.findByUserAndCourse(userId, courseId)) {
      throw new ConflictException('User is already enrolled in this course');
    }
    const enrolment: Enrolment = {
      id: newId('enrolment'),
      courseId,
      userId,
      progressPercent: 0,
      status: 'enrolled',
      enrolledAt: new Date().toISOString()
    };
    const created = await this.enrolments.create(enrolment);
    await this.courses.update(course.id, { enrolmentCount: course.enrolmentCount + 1 });
    await this.events.publish('learning.enrolment.created', { enrolmentId: created.id, courseId }, userId);
    return created;
  }

  async getEnrolment(id: string): Promise<Enrolment> {
    return this.enrolments.getById(id);
  }

  async enrolmentsForUser(userId: string): Promise<Enrolment[]> {
    return this.enrolments.find({ userId });
  }

  async updateProgress(id: string, progressPercent: number): Promise<Enrolment> {
    const enrolment = await this.enrolments.getById(id);
    if (progressPercent < enrolment.progressPercent) {
      throw new BadRequestException('Progress cannot move backwards');
    }
    const clamped = Math.min(100, progressPercent);
    const status: Enrolment['status'] =
      clamped >= 100 ? 'completed' : clamped > 0 ? 'in_progress' : enrolment.status;
    const updated = await this.enrolments.update(id, {
      progressPercent: clamped,
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : enrolment.completedAt
    });
    if (status === 'completed' && enrolment.status !== 'completed') {
      await this.issueCertificate(updated);
    }
    return updated;
  }

  async certificatesForUser(userId: string): Promise<Certificate[]> {
    return this.certificates.find({ userId });
  }

  async verifyCertificate(
    code: string,
    learnerName?: (userId: string) => Promise<string | undefined>
  ): Promise<CertificateVerification> {
    const certificate = await this.certificates.findOne({ verificationCode: code });
    if (!certificate) {
      return { valid: false };
    }
    const course = await this.courses.findById(certificate.courseId);
    return {
      valid: true,
      certificate,
      courseTitle: course?.title,
      learnerName: learnerName ? await learnerName(certificate.userId) : undefined
    };
  }

  async completionCount(): Promise<number> {
    return this.enrolments.countCompleted();
  }

  private async issueCertificate(enrolment: Enrolment): Promise<Certificate> {
    const code = await this.certificates.allocateVerificationCode();
    const certificate: Certificate = {
      id: newId('cert'),
      userId: enrolment.userId,
      courseId: enrolment.courseId,
      verificationCode: code,
      issuedAt: new Date().toISOString(),
      verificationUrl: `/api/v1/certificates/verify/${code}`
    };
    const created = await this.certificates.create(certificate);
    await this.events.publish(
      'learning.certificate.issued',
      { certificateId: created.id, courseId: enrolment.courseId, verificationCode: code },
      enrolment.userId
    );
    return created;
  }
}
