import { Injectable } from '@nestjs/common';
import { AdvisoryService } from '../advisory/advisory.service.js';
import { ChaptersService } from '../chapters/chapters.service.js';
import { CommunityService } from '../community/community.service.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';

export type SearchResultType =
  | 'course'
  | 'opportunity'
  | 'listing'
  | 'advisory'
  | 'chapter'
  | 'topic';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  summary: string;
  score: number;
  state?: string;
}

/**
 * Cross-domain discovery. Phase 1 fans out across the domain repositories
 * (full-table scans acceptable at this scale); production swaps in the
 * Meilisearch adapter while keeping this result contract.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    private readonly advisory: AdvisoryService,
    private readonly chapters: ChaptersService,
    private readonly community: CommunityService
  ) {}

  async search(
    query: string,
    types?: SearchResultType[],
    state?: string,
    limit = 20
  ): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const wanted = types?.length ? new Set(types) : null;
    const results: SearchResult[] = [];

    const score = (text: string): number => {
      const haystack = text.toLowerCase();
      if (haystack === q) return 3;
      if (haystack.startsWith(q)) return 2;
      return haystack.includes(q) ? 1 : 0;
    };

    const [courses, opportunities, listings, advisoryItems, chapterList, topics] =
      await Promise.all([
        !wanted || wanted.has('course') ? this.learning.allCourses() : Promise.resolve([]),
        !wanted || wanted.has('opportunity') ? this.opportunities.all() : Promise.resolve([]),
        !wanted || wanted.has('listing') ? this.marketplace.allListings() : Promise.resolve([]),
        !wanted || wanted.has('advisory') ? this.advisory.all() : Promise.resolve([]),
        !wanted || wanted.has('chapter') ? this.chapters.all() : Promise.resolve([]),
        !wanted || wanted.has('topic') ? this.community.allTopics() : Promise.resolve([])
      ]);

    for (const course of courses) {
      const s = score(`${course.title} ${course.category}`);
      if (s > 0) {
        results.push({ type: 'course', id: course.id, title: course.title, summary: course.category, score: s });
      }
    }
    for (const opp of opportunities) {
      if (state && !opp.states.includes(state)) continue;
      const s = score(`${opp.title} ${opp.description}`);
      if (s > 0) {
        results.push({ type: 'opportunity', id: opp.id, title: opp.title, summary: opp.description, score: s });
      }
    }
    for (const listing of listings) {
      if (state && listing.location.state !== state) continue;
      const s = score(`${listing.title} ${listing.crop ?? ''}`);
      if (s > 0) {
        results.push({
          type: 'listing',
          id: listing.id,
          title: listing.title,
          summary: `${listing.quantity} ${listing.unit} — ${listing.location.state}`,
          score: s,
          state: listing.location.state
        });
      }
    }
    for (const item of advisoryItems) {
      if (state && item.state && item.state !== state) continue;
      const s = score(`${item.title} ${item.summary}`);
      if (s > 0) {
        results.push({ type: 'advisory', id: item.id, title: item.title, summary: item.summary, score: s, state: item.state });
      }
    }
    for (const chapter of chapterList) {
      if (state && chapter.state !== state) continue;
      const s = score(chapter.name);
      if (s > 0) {
        results.push({ type: 'chapter', id: chapter.id, title: chapter.name, summary: `${chapter.level} chapter`, score: s, state: chapter.state });
      }
    }
    for (const topic of topics) {
      if (state && topic.state && topic.state !== state) continue;
      const s = score(topic.title);
      if (s > 0) {
        results.push({ type: 'topic', id: topic.id, title: topic.title, summary: topic.category, score: s, state: topic.state });
      }
    }

    return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  async suggest(query: string, limit = 5): Promise<string[]> {
    return (await this.search(query, undefined, undefined, limit)).map((r) => r.title);
  }
}
