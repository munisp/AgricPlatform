import { describe, expect, it } from 'vitest';
import type { AdvisoryItem, Course, MarketplaceListing } from '@agric-platform/shared';
import type { AdvisoryService } from '../advisory/advisory.service.js';
import type { ChaptersService } from '../chapters/chapters.service.js';
import type { CommunityService } from '../community/community.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { MarketplaceService } from '../marketplace/marketplace.service.js';
import type { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { createInMemorySearchQueryRepository } from '../../database/repositories/search-query.repository.js';
import { SearchService } from './search.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-08T12:00:00.000Z');

function makeService(overrides: {
  courses?: Course[];
  listings?: MarketplaceListing[];
  advisory?: AdvisoryItem[];
} = {}) {
  const queryEvents = createInMemorySearchQueryRepository();
  const service = new SearchService(
    { allCourses: async () => overrides.courses ?? [] } as unknown as LearningService,
    { all: async () => [] } as unknown as OpportunitiesService,
    { allListings: async () => overrides.listings ?? [] } as unknown as MarketplaceService,
    { all: async () => overrides.advisory ?? [] } as unknown as AdvisoryService,
    { all: async () => [] } as unknown as ChaptersService,
    { allTopics: async () => [] } as unknown as CommunityService,
    queryEvents
  );
  return { service, queryEvents };
}

describe('SearchService trending queries', () => {
  it('decays occurrences with a 2-day half-life inside the 7-day window', async () => {
    const { service } = makeService();
    // 'maize': one search right now (weight 1) + one 2 days ago (weight 0.5).
    await service.recordQuery('maize', NOW);
    await service.recordQuery('maize', new Date(NOW.getTime() - 2 * DAY_MS));
    // 'rice': one search 4 days ago (weight 0.25).
    await service.recordQuery('rice', new Date(NOW.getTime() - 4 * DAY_MS));
    const trending = await service.trending({ now: NOW });
    expect(trending).toHaveLength(2);
    expect(trending[0]).toMatchObject({ query: 'maize', occurrences: 2 });
    expect(trending[0].score).toBeCloseTo(1.5, 4);
    expect(trending[1]).toMatchObject({ query: 'rice', occurrences: 1 });
    expect(trending[1].score).toBeCloseTo(0.25, 4);
  });

  it('excludes occurrences outside the window and in the future', async () => {
    const { service } = makeService();
    await service.recordQuery('old-topic', new Date(NOW.getTime() - 8 * DAY_MS));
    await service.recordQuery('future-topic', new Date(NOW.getTime() + DAY_MS));
    await service.recordQuery('fresh', NOW);
    const trending = await service.trending({ now: NOW });
    expect(trending.map((t) => t.query)).toEqual(['fresh']);
  });

  it('records every executed search query', async () => {
    const { service, queryEvents } = makeService();
    await service.search('fertiliser prices');
    await service.search('   ');
    const events = await queryEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0].query).toBe('fertiliser prices');
  });
});

describe('SearchService related items', () => {
  const courses: Course[] = [
    {
      id: 'course-1',
      title: 'Maize agronomy',
      category: 'agronomy',
      level: 'beginner',
      durationMinutes: 30,
      language: 'en',
      enrolmentCount: 0,
      offlineAvailable: false
    },
    {
      id: 'course-2',
      title: 'Advanced agronomy',
      category: 'agronomy',
      level: 'advanced',
      durationMinutes: 45,
      language: 'en',
      enrolmentCount: 0,
      offlineAvailable: false
    }
  ];
  const advisory: AdvisoryItem[] = [
    {
      id: 'adv-1',
      kind: 'guide',
      title: 'Agronomy guide',
      summary: 'Field guide',
      publishedAt: '2026-01-01T00:00:00.000Z'
    }
  ];

  it('ranks items by shared-tag count and excludes the source item', async () => {
    const { service } = makeService({ courses, advisory });
    const related = await service.related('course', 'course-1');
    // course-2 shares 'agronomy' (1 tag); adv-1 shares 'agronomy' via kind 'guide'? no — 'guide' ≠ 'agronomy'.
    expect(related.map((r) => r.id)).toEqual(['course-2']);
    expect(related[0].score).toBe(1);
  });

  it('matches advisory items through crop tags', async () => {
    const listings: MarketplaceListing[] = [
      {
        id: 'listing-1',
        sellerId: 'user-adamu',
        kind: 'produce',
        title: 'Fresh maize',
        crop: 'maize',
        quantity: 10,
        unit: 'bags',
        priceNaira: 30000,
        location: { state: 'Kano', lga: 'Nassarawa' },
        isActive: true
      }
    ];
    const { service } = makeService({
      listings,
      advisory: [{ ...advisory[0], id: 'adv-2', title: 'Maize pest alert', crop: 'maize' }]
    });
    const related = await service.related('listing', 'listing-1');
    expect(related.map((r) => r.id)).toEqual(['adv-2']);
  });

  it('returns an empty list for unknown or tagless sources', async () => {
    const { service } = makeService({ courses });
    expect(await service.related('course', 'missing')).toEqual([]);
    expect(await service.related('advisory', 'adv-1')).toEqual([]);
  });
});
