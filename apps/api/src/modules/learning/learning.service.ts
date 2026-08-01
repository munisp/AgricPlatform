import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { ApiListResponse, Certificate, Course, Enrolment, LanguageCode } from '@agric-platform/shared';
import { seedCourses } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { seedCertificates, seedEnrolments } from '../../database/seed-data.js';

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
  private readonly courses = new InMemoryRepository<Course>(seedCourses);
  private readonly enrolments = new InMemoryRepository<Enrolment>(seedEnrolments);
  private readonly certificates = new InMemoryRepository<Certificate>(seedCertificates);
  private certificateSequence = 2;

  constructor(private readonly events: DomainEventsService) {}

  listCourses(filter: {
    category?: string;
    level?: Course['level'];
    language?: LanguageCode;
    q?: string;
    page?: number;
    pageSize?: number;
  }): ApiListResponse<Course> {
    let items = this.courses.all();
    if (filter.category) items = items.filter((c) => c.category === filter.category);
    if (filter.level) items = items.filter((c) => c.level === filter.level);
    if (filter.language) items = items.filter((c) => c.language === filter.language);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      items = items.filter((c) => c.title.toLowerCase().includes(q));
    }
    return paginate(items, filter.page, filter.pageSize);
  }

  allCourses(): Course[] {
    return this.courses.all();
  }

  getCourse(id: string): Course {
    return this.courses.getById(id);
  }

  createCourse(input: CreateCourseInput): Course {
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
    const created = this.courses.create(course);
    this.events.publish('learning.course.created', { courseId: created.id });
    return created;
  }

  enrol(courseId: string, userId: string): Enrolment {
    const course = this.courses.getById(courseId);
    const existing = this.enrolments.findOne(
      (e) => e.courseId === courseId && e.userId === userId
    );
    if (existing) {
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
    const created = this.enrolments.create(enrolment);
    this.courses.update(course.id, { enrolmentCount: course.enrolmentCount + 1 });
    this.events.publish('learning.enrolment.created', { enrolmentId: created.id, courseId }, userId);
    return created;
  }

  getEnrolment(id: string): Enrolment {
    return this.enrolments.getById(id);
  }

  enrolmentsForUser(userId: string): Enrolment[] {
    return this.enrolments.find((e) => e.userId === userId);
  }

  updateProgress(id: string, progressPercent: number): Enrolment {
    const enrolment = this.enrolments.getById(id);
    if (progressPercent < enrolment.progressPercent) {
      throw new BadRequestException('Progress cannot move backwards');
    }
    const clamped = Math.min(100, progressPercent);
    const status: Enrolment['status'] =
      clamped >= 100 ? 'completed' : clamped > 0 ? 'in_progress' : enrolment.status;
    const updated = this.enrolments.update(id, {
      progressPercent: clamped,
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : enrolment.completedAt
    });
    if (status === 'completed' && enrolment.status !== 'completed') {
      this.issueCertificate(updated);
    }
    return updated;
  }

  certificatesForUser(userId: string): Certificate[] {
    return this.certificates.find((c) => c.userId === userId);
  }

  verifyCertificate(code: string, learnerName?: (userId: string) => string | undefined): CertificateVerification {
    const certificate = this.certificates.findOne((c) => c.verificationCode === code);
    if (!certificate) {
      return { valid: false };
    }
    const course = this.courses.findById(certificate.courseId);
    return {
      valid: true,
      certificate,
      courseTitle: course?.title,
      learnerName: learnerName?.(certificate.userId)
    };
  }

  completionCount(): number {
    return this.enrolments.count((e) => e.status === 'completed');
  }

  private issueCertificate(enrolment: Enrolment): Certificate {
    const code = `NYFN-CERT-${new Date().getFullYear()}-${String(this.certificateSequence++).padStart(4, '0')}`;
    const certificate: Certificate = {
      id: newId('cert'),
      userId: enrolment.userId,
      courseId: enrolment.courseId,
      verificationCode: code,
      issuedAt: new Date().toISOString(),
      verificationUrl: `/api/v1/certificates/verify/${code}`
    };
    const created = this.certificates.create(certificate);
    this.events.publish(
      'learning.certificate.issued',
      { certificateId: created.id, courseId: enrolment.courseId, verificationCode: code },
      enrolment.userId
    );
    return created;
  }
}
