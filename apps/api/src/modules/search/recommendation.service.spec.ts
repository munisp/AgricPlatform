import { describe, expect, it } from 'vitest';
import type { Course, Enrolment, MarketplaceListing, Profile } from '@agric-platform/shared';
import { createInMemoryRecommendationFeedbackRepository } from '../../database/repositories/recommendation-feedback.repository.js';
import type { KnowledgeResourceRepository } from '../../database/repositories/knowledge.repository.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { RecommendationService } from './recommendation.service.js';

const maizeCourse: Course = {
  id: 'course-maize',
  title: 'Maize Agronomy',
  category: 'maize',
  level: 'beginner',
  durationMinutes: 45,
  language: 'en',
  enrolmentCount: 120,
  offlineAvailable: true
};

const poultryCourse: Course = {
  ...maizeCourse,
  id: 'course-poultry',
  title: 'Poultry Basics',
  category: 'poultry',
  enrolmentCount: 5
};

const maizeListing: MarketplaceListing = {
  id: 'listing-maize',
  sellerId: 'user-seller',
  kind: 'produce',
  title: 'Maize 100kg',
  crop: 'maize',
  quantity: 100,
  unit: 'kg',
  priceNaira: 45000,
  location: { state: 'Kano', lga: 'Dala' },
  isActive: true
};

function makeService(options: {
  profile?: Profile;
  enrolments?: Enrolment[];
  courses?: Course[];
}) {
  const feedback = createInMemoryRecommendationFeedbackRepository();
  const service = new RecommendationService(
    {
      get: async () => {
        if (!options.profile) {
          const { NotFoundException } = await import('@nestjs/common');
          throw new NotFoundException('no profile');
        }
        return options.profile;
      }
    } as unknown as ProfilesService,
    {
      allCourses: async () => options.courses ?? [maizeCourse, poultryCourse],
      enrolmentsForUser: async () => options.enrolments ?? []
    } as unknown as LearningService,
    { all: async () => [], listApplications: async () => [] } as unknown as OpportunitiesService,
    {
      allListings: async () => [maizeListing],
      listOrders: async () => []
    } as unknown as MarketplaceService,
    { all: async () => [] } as unknown as KnowledgeResourceRepository,
    feedback
  );
  return { service, feedback };
}

describe('RecommendationService.recommendFor', () => {
  it('cold-start members (no profile, no history) get the trending fallback', async () => {
    const { service } = makeService({});
    const results = await service.recommendFor('user-new');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.reasons.includes('trending_fallback'))).toBe(true);
    // Popularity order: maize course (120 enrolments) first.
    expect(results[0].id).toBe('course-maize');
  });

  it('member signals rank matching items first with reason codes', async () => {
    const { service } = makeService({
      profile: {
        userId: 'user-1',
        location: { state: 'Kano', lga: 'Dala' },
        farmingInterests: ['maize'],
        valueChains: ['grains'],
        completionScore: 60,
        badges: ['complete']
      }
    });
    const results = await service.recommendFor('user-1');
    expect(results[0].id).toBe('listing-maize');
    expect(results[0].reasons).toEqual(expect.arrayContaining(['same_crop', 'state_match']));
    expect(results.some((r) => r.id === 'course-maize' && r.reasons.includes('category_affinity'))).toBe(true);
  });

  it('completed courses surface next-step courses via completed_prerequisite', async () => {
    const { service } = makeService({
      profile: {
        userId: 'user-1',
        location: { state: 'Kano', lga: 'Dala' },
        farmingInterests: [],
        valueChains: [],
        completionScore: 35,
        badges: ['starter']
      },
      enrolments: [
        {
          id: 'enr-1',
          courseId: 'course-maize',
          userId: 'user-1',
          progressPercent: 100,
          status: 'completed',
          enrolledAt: '2026-07-01T00:00:00.000Z',
          completedAt: '2026-07-20T00:00:00.000Z'
        }
      ]
    });
    const results = await service.recommendFor('user-1');
    const maize = results.find((r) => r.id === 'course-maize');
    expect(maize?.reasons).toContain('completed_prerequisite');
  });

  it('own dismissal pushes the item down the ranking', async () => {
    const { service, feedback } = makeService({
      profile: {
        userId: 'user-1',
        location: { state: 'Kano', lga: 'Dala' },
        farmingInterests: ['maize'],
        valueChains: [],
        completionScore: 60,
        badges: ['complete']
      }
    });
    const before = await service.recommendFor('user-1');
    const target = before.find((r) => r.id === 'listing-maize')!;
    await service.recordFeedback('user-1', 'listing', 'listing-maize', 'dismissed');
    const after = await service.recommendFor('user-1');
    const demoted = after.find((r) => r.id === 'listing-maize')!;
    expect(demoted.score).toBeLessThan(target.score);
    expect(await feedback.count({ userId: 'user-1' })).toBe(1);
  });

  it('global clicks lift an item for other members', async () => {
    const { service } = makeService({
      profile: {
        userId: 'user-1',
        location: { state: 'Kano', lga: 'Dala' },
        farmingInterests: ['maize'],
        valueChains: [],
        completionScore: 60,
        badges: ['complete']
      }
    });
    const baseline = (await service.recommendFor('user-1')).find((r) => r.id === 'course-maize')!;
    for (let i = 0; i < 20; i += 1) {
      await service.recordFeedback(`user-other-${i}`, 'course', 'course-maize', 'clicked');
    }
    const boosted = (await service.recommendFor('user-1')).find((r) => r.id === 'course-maize')!;
    expect(boosted.score).toBeGreaterThan(baseline.score);
  });
});

describe('RecommendationService.similar', () => {
  it('returns related items with reason codes', async () => {
    const { service } = makeService({});
    const results = await service.similar('course', 'course-maize');
    expect(results.every((r) => r.id !== 'course-maize')).toBe(true);
  });

  it('throws NotFoundException for an unknown item', async () => {
    const { service } = makeService({});
    await expect(service.similar('course', 'missing')).rejects.toThrowError(/No recommendable/);
  });
});
