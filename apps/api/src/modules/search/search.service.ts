import { Inject, Injectable } from '@nestjs/common';
import type { TrendingQuery } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { SEARCH_QUERY_REPOSITORY } from '../../database/persistence.tokens.js';
import type { SearchQueryRepository } from '../../database/repositories/search-query.repository.js';
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

/** Trailing window for trending queries (M16). */
export const TRENDING_WINDOW_DAYS = 7;
/** Half-life applied to each occurrence inside the window. */
export const TRENDING_HALF_LIFE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

interface TaggableItem {
  type: SearchResultType;
  id: string;
  title: string;
  summary: string;
  tags: string[];
  state?: string;
}

/**
 * Cross-domain discovery. Phase 1 fans out across the domain repositories
 * (full-table scans acceptable at this scale); production swaps in the
 * Meilisearch adapter while keeping this result contract. M16 adds
 * count-backed trending queries (decayed over a 7-day window) and
 * tag-co-occurrence related items, both computed behind this service so the
 * provider port stays a drop-in boundary.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    private readonly advisory: AdvisoryService,
    private readonly chapters: ChaptersService,
    private readonly community: CommunityService,
    @Inject(SEARCH_QUERY_REPOSITORY) private readonly queryEvents: SearchQueryRepository
  ) {}

  async search(
    query: string,
    types?: SearchResultType[],
    state?: string,
    limit = 20
  ): Promise<SearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    await this.recordQuery(q);
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

  // -- M16: trending queries --------------------------------------------------

  /** Records a search occurrence; `at` is injectable for deterministic tests. */
  async recordQuery(query: string, at: Date = new Date()): Promise<void> {
    await this.queryEvents.create({
      id: newId('query'),
      query,
      occurredAt: at.toISOString()
    });
  }

  /**
   * Trending queries over the trailing `windowDays` (default 7). Each
   * occurrence contributes 2^(-ageDays / halfLifeDays) so recent searches
   * weigh more; occurrences outside the window are excluded entirely.
   */
  async trending(
    options: { now?: Date; limit?: number; windowDays?: number; halfLifeDays?: number } = {}
  ): Promise<TrendingQuery[]> {
    const now = options.now ?? new Date();
    const windowDays = options.windowDays ?? TRENDING_WINDOW_DAYS;
    const halfLifeDays = options.halfLifeDays ?? TRENDING_HALF_LIFE_DAYS;
    const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
    const events = await this.queryEvents.find({ since });
    const buckets = new Map<string, { score: number; occurrences: number }>();
    for (const event of events) {
      const ageDays = (now.getTime() - Date.parse(event.occurredAt)) / DAY_MS;
      if (ageDays < 0 || ageDays > windowDays) continue;
      const weight = Math.pow(2, -ageDays / halfLifeDays);
      const bucket = buckets.get(event.query) ?? { score: 0, occurrences: 0 };
      bucket.score += weight;
      bucket.occurrences += 1;
      buckets.set(event.query, bucket);
    }
    return [...buckets.entries()]
      .map(([query, bucket]) => ({
        query,
        score: Math.round(bucket.score * 10000) / 10000,
        occurrences: bucket.occurrences
      }))
      .sort((a, b) => b.score - a.score || a.query.localeCompare(b.query))
      .slice(0, options.limit ?? 10);
  }

  // -- M16: related items ------------------------------------------------------

  /** Related items by shared-tag co-occurrence (same-type and cross-type). */
  async related(type: SearchResultType, id: string, limit = 10): Promise<SearchResult[]> {
    const items = await this.collectTaggableItems();
    const source = items.find((item) => item.type === type && item.id === id);
    if (!source || source.tags.length === 0) {
      return [];
    }
    const sourceTags = new Set(source.tags);
    return items
      .filter((item) => !(item.type === type && item.id === id))
      .map((item) => ({
        item,
        shared: item.tags.filter((tag) => sourceTags.has(tag)).length
      }))
      .filter(({ shared }) => shared > 0)
      .sort((a, b) => b.shared - a.shared || a.item.title.localeCompare(b.item.title))
      .slice(0, limit)
      .map(({ item, shared }) => ({
        type: item.type,
        id: item.id,
        title: item.title,
        summary: item.summary,
        score: shared,
        state: item.state
      }));
  }

  private async collectTaggableItems(): Promise<TaggableItem[]> {
    const [courses, opportunities, listings, advisoryItems, chapterList, topics] =
      await Promise.all([
        this.learning.allCourses(),
        this.opportunities.all(),
        this.marketplace.allListings(),
        this.advisory.all(),
        this.chapters.all(),
        this.community.allTopics()
      ]);
    const norm = (value: string | undefined): string[] =>
      value ? [value.trim().toLowerCase()] : [];
    const items: TaggableItem[] = [];
    for (const course of courses) {
      items.push({
        type: 'course',
        id: course.id,
        title: course.title,
        summary: course.category,
        tags: norm(course.category)
      });
    }
    for (const opp of opportunities) {
      items.push({
        type: 'opportunity',
        id: opp.id,
        title: opp.title,
        summary: opp.description,
        tags: [...opp.valueChains.map((v) => v.toLowerCase()), ...opp.states.map((s) => s.toLowerCase())]
      });
    }
    for (const listing of listings) {
      items.push({
        type: 'listing',
        id: listing.id,
        title: listing.title,
        summary: `${listing.quantity} ${listing.unit} — ${listing.location.state}`,
        tags: [...norm(listing.crop), ...norm(listing.kind)],
        state: listing.location.state
      });
    }
    for (const item of advisoryItems) {
      items.push({
        type: 'advisory',
        id: item.id,
        title: item.title,
        summary: item.summary,
        tags: [...norm(item.crop), ...norm(item.kind)],
        state: item.state
      });
    }
    for (const chapter of chapterList) {
      items.push({
        type: 'chapter',
        id: chapter.id,
        title: chapter.name,
        summary: `${chapter.level} chapter`,
        tags: [chapter.state.toLowerCase()],
        state: chapter.state
      });
    }
    for (const topic of topics) {
      items.push({
        type: 'topic',
        id: topic.id,
        title: topic.title,
        summary: topic.category,
        tags: [...norm(topic.category), ...norm(topic.crop)],
        state: topic.state
      });
    }
    return items;
  }
}
