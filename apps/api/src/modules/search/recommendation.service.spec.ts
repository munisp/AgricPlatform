import { describe, expect, it } from 'vitest';
import type {
  Course,
  Enrolment,
  MarketplaceListing,
  Profile,
  TrendingQuery
} from '@agric-platform/shared';
import { createInMemoryRecommendationFeedbackRepository } from '../../database/repositories/recommendation-feedback.repository.js';
import type { KnowledgeResourceRepository } from '../../database/repositories/knowledge.repository.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { RecommendationService } from './recommendation.service.js';
import type { SearchService } from './search.service.js';

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
  trending?: TrendingQuery[];
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
    feedback,
    { trending: async () => options.trending ?? [] } as unknown as SearchService
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

  it('cold-start members get trending-query matches first with the trending_query reason', async () => {
    const { service } = makeService({
      trending: [
        { query: 'poultry', score: 2.5, occurrences: 4 },
        { query: 'cassava stems', score: 1.2, occurrences: 2 }
      ]
    });
    const results = await service.recommendFor('user-new');
    // poultry course (popularity 5) matches 'poultry' and outranks the more
    // popular maize course (120 enrolments, unmatched).
    expect(results[0].id).toBe('course-poultry');
    expect(results[0].reasons).toEqual(['trending_query']);
    const maize = results.find((r) => r.id === 'course-maize');
    expect(maize?.reasons).toEqual(['trending_fallback']);
    // Trending-matched items all lead the unmatched fallback items.
    const lastMatched = results.map((r) => r.reasons[0]).lastIndexOf('trending_query');
    const firstFallback = results.map((r) => r.reasons[0]).indexOf('trending_fallback');
    expect(lastMatched).toBeLessThan(firstFallback);
  });

  it('multi-word trending queries only match items carrying every term', async () => {
    const { service } = makeService({
      trending: [{ query: 'maize agronomy', score: 3, occurrences: 5 }]
    });
    const results = await service.recommendFor('user-new');
    const course = results.find((r) => r.id === 'course-maize');
    const listing = results.find((r) => r.id === 'listing-maize');
    // Title 'Maize Agronomy' carries both terms; 'Maize 100kg' lacks 'agronomy'.
    expect(course?.reasons).toEqual(['trending_query']);
    expect(listing?.reasons).toEqual(['trending_fallback']);
    expect(results[0].id).toBe('course-maize');
  });

  it('falls back to pure popularity when no trending query matches', async () => {
    const { service } = makeService({
      trending: [{ query: 'apiculture', score: 1, occurrences: 1 }]
    });
    const results = await service.recommendFor('user-new');
    expect(results.every((r) => r.reasons.includes('trending_fallback'))).toBe(true);
    expect(results[0].id).toBe('course-maize');
  });

  it('trending blend does not affect members with signals', async () => {
    const { service } = makeService({
      profile: {
        userId: 'user-1',
        location: { state: 'Kano', lga: 'Dala' },
        farmingInterests: ['maize'],
        valueChains: [],
        completionScore: 60,
        badges: ['complete']
      },
      trending: [{ query: 'poultry', score: 5, occurrences: 9 }]
    });
    const results = await service.recommendFor('user-1');
    expect(results.every((r) => !r.reasons.includes('trending_query'))).toBe(true);
    expect(results[0].id).toBe('listing-maize');
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
