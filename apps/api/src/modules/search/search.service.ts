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
 * Cross-domain discovery. Phase 1 searches in-memory repositories (stub
 * search driver); production swaps in the Meilisearch adapter while keeping
 * this result contract.
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

  search(query: string, types?: SearchResultType[], state?: string, limit = 20): SearchResult[] {
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

    if (!wanted || wanted.has('course')) {
      for (const course of this.learning.allCourses()) {
        const s = score(`${course.title} ${course.category}`);
        if (s > 0) {
          results.push({ type: 'course', id: course.id, title: course.title, summary: course.category, score: s });
        }
      }
    }
    if (!wanted || wanted.has('opportunity')) {
      for (const opp of this.opportunities.all()) {
        if (state && !opp.states.includes(state)) continue;
        const s = score(`${opp.title} ${opp.description}`);
        if (s > 0) {
          results.push({ type: 'opportunity', id: opp.id, title: opp.title, summary: opp.description, score: s });
        }
      }
    }
    if (!wanted || wanted.has('listing')) {
      for (const listing of this.marketplace.allListings()) {
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
    }
    if (!wanted || wanted.has('advisory')) {
      for (const item of this.advisory.all()) {
        if (state && item.state && item.state !== state) continue;
        const s = score(`${item.title} ${item.summary}`);
        if (s > 0) {
          results.push({ type: 'advisory', id: item.id, title: item.title, summary: item.summary, score: s, state: item.state });
        }
      }
    }
    if (!wanted || wanted.has('chapter')) {
      for (const chapter of this.chapters.all()) {
        if (state && chapter.state !== state) continue;
        const s = score(chapter.name);
        if (s > 0) {
          results.push({ type: 'chapter', id: chapter.id, title: chapter.name, summary: `${chapter.level} chapter`, score: s, state: chapter.state });
        }
      }
    }
    if (!wanted || wanted.has('topic')) {
      for (const topic of this.community.allTopics()) {
        if (state && topic.state && topic.state !== state) continue;
        const s = score(topic.title);
        if (s > 0) {
          results.push({ type: 'topic', id: topic.id, title: topic.title, summary: topic.category, score: s, state: topic.state });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  suggest(query: string, limit = 5): string[] {
    return this.search(query, undefined, undefined, limit).map((r) => r.title);
  }
}
