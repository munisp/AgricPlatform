import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryCertificateRepository } from '../../database/repositories/certificate.repository.js';
import { createInMemoryCourseRepository } from '../../database/repositories/course.repository.js';
import { createInMemoryEnrolmentRepository } from '../../database/repositories/enrolment.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LearningService } from './learning.service.js';

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new LearningService(
    events,
    createInMemoryCourseRepository(),
    createInMemoryEnrolmentRepository(),
    createInMemoryCertificateRepository()
  );
  return { service };
}

describe('LearningService course persistence (GAP-L12)', () => {
  it('persists slug, description and the published flag on course creation', async () => {
    const { service } = makeService();
    const course = await service.createCourse({
      title: 'Maize Agronomy 101',
      category: 'agronomy',
      level: 'beginner',
      durationMinutes: 45,
      language: 'en',
      slug: 'maize-agronomy-101',
      description: 'Foundations of maize production for smallholders.',
      published: true
    });
    expect(course.slug).toBe('maize-agronomy-101');
    expect(course.description).toBe('Foundations of maize production for smallholders.');
    expect(course.published).toBe(true);
    const stored = await service.getCourse(course.id);
    expect(stored.slug).toBe('maize-agronomy-101');
    expect(stored.published).toBe(true);
  });

  it('defaults new courses to unpublished with no slug/description', async () => {
    const { service } = makeService();
    const course = await service.createCourse({
      title: 'Draft course',
      category: 'general',
      level: 'beginner',
      durationMinutes: 30,
      language: 'en'
    });
    expect(course.published).toBe(false);
    expect(course.slug).toBeUndefined();
    expect(course.description).toBeUndefined();
  });
});
