import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import {
  KNOWLEDGE_RESOURCE_REPOSITORY,
  RECOMMENDATION_FEEDBACK_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { KnowledgeResourceRepository } from '../../database/repositories/knowledge.repository.js';
import type { RecommendationFeedbackRepository } from '../../database/repositories/recommendation-feedback.repository.js';
import { LearningService } from '../learning/learning.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { OpportunitiesService } from '../opportunities/opportunities.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import {
  aggregateFeedback,
  adjustScore,
  ownActions,
  type FeedbackAction
} from './recommendation-feedback.js';
import {
  coldStartRank,
  emptySignals,
  isColdStart,
  rankCandidates,
  similarItems,
  type MemberSignals,
  type RecommendationCandidate,
  type RecommendationType,
  type RecommenderWeights,
  type ScoredRecommendation
} from './recommender.js';

const norm = (value: string | undefined): string | undefined =>
  value && value.trim() !== '' ? value.trim().toLowerCase() : undefined;

/**
 * Member-facing recommendation service (M16 Phase 3). Orchestrates domain
 * services into member signals + content candidates, then delegates ranking
 * to the pure scorer in `recommender.ts`. Persisted feedback events adjust
 * future rankings via Bayesian-smoothed multipliers.
 */
@Injectable()
export class RecommendationService {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly learning: LearningService,
    private readonly opportunities: OpportunitiesService,
    private readonly marketplace: MarketplaceService,
    @Inject(KNOWLEDGE_RESOURCE_REPOSITORY) private readonly knowledge: KnowledgeResourceRepository,
    @Inject(RECOMMENDATION_FEEDBACK_REPOSITORY)
    private readonly feedback: RecommendationFeedbackRepository
  ) {}

  /** Builds the member signal profile from profile, learning and order history. */
  async signalsFor(userId: string): Promise<MemberSignals> {
    const signals = emptySignals();
    const profile = await this.profiles.get(userId).catch((error: unknown) => {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    });
    if (profile) {
      signals.state = norm(profile.location?.state);
      signals.lga = norm(profile.location?.lga);
      signals.crops = profile.farmingInterests.map((c) => c.toLowerCase());
      signals.valueChains = profile.valueChains.map((v) => v.toLowerCase());
    }

    const [enrolments, courses, orders, listings, applications] = await Promise.all([
      this.learning.enrolmentsForUser(userId),
      this.learning.allCourses(),
      this.marketplace.listOrders({ buyerId: userId }),
      this.marketplace.allListings(),
      this.opportunities.listApplications({ userId })
    ]);
    const categoriesByCourse = new Map(courses.map((course) => [course.id, course.category.toLowerCase()]));
    for (const enrolment of enrolments) {
      const category = categoriesByCourse.get(enrolment.courseId);
      if (!category) continue;
      if (enrolment.status === 'completed') {
        if (!signals.completedCourseCategories.includes(category)) {
          signals.completedCourseCategories.push(category);
        }
      } else if (!signals.activeCourseCategories.includes(category)) {
        signals.activeCourseCategories.push(category);
      }
    }
    const listingById = new Map(listings.map((listing) => [listing.id, listing]));
    for (const order of orders) {
      const listing = listingById.get(order.listingId);
      if (!listing) continue;
      const crop = norm(listing.crop);
      if (crop && !signals.purchasedCrops.includes(crop)) signals.purchasedCrops.push(crop);
      if (!signals.purchasedKinds.includes(listing.kind)) signals.purchasedKinds.push(listing.kind);
    }
    const opportunities = await this.opportunities.all();
    const typeByOpportunity = new Map(opportunities.map((opp) => [opp.id, opp.type]));
    for (const application of applications) {
      const type = typeByOpportunity.get(application.opportunityId);
      if (type && !signals.appliedOpportunityTypes.includes(type)) {
        signals.appliedOpportunityTypes.push(type);
      }
    }
    return signals;
  }

  /** Collects scored candidates across courses, opportunities, listings, knowledge. */
  async collectCandidates(): Promise<RecommendationCandidate[]> {
    const [courses, opportunities, listings, resources] = await Promise.all([
      this.learning.allCourses(),
      this.opportunities.all(),
      this.marketplace.allListings(),
      this.knowledge.all()
    ]);
    const candidates: RecommendationCandidate[] = [];
    for (const course of courses) {
      candidates.push({
        type: 'course',
        id: course.id,
        title: course.title,
        summary: course.category,
        tags: [course.category.toLowerCase()],
        category: course.category.toLowerCase(),
        popularity: course.enrolmentCount
      });
    }
    for (const opp of opportunities) {
      if (!opp.isActive) continue;
      candidates.push({
        type: 'opportunity',
        id: opp.id,
        title: opp.title,
        summary: opp.description,
        tags: opp.valueChains.map((v) => v.toLowerCase()),
        states: opp.states.map((s) => s.toLowerCase()),
        kind: opp.type,
        popularity: 1
      });
    }
    for (const listing of listings) {
      if (!listing.isActive) continue;
      candidates.push({
        type: 'listing',
        id: listing.id,
        title: listing.title,
        summary: `${listing.quantity} ${listing.unit} — ${listing.location.state}`,
        tags: [norm(listing.crop), norm(listing.kind)].filter((v): v is string => v !== undefined),
        crop: listing.crop,
        state: listing.location.state,
        kind: listing.kind,
        popularity: 1
      });
    }
    for (const resource of resources) {
      candidates.push({
        type: 'knowledge',
        id: resource.id,
        title: resource.title,
        summary: resource.tags.join(', '),
        tags: resource.tags.map((t) => t.toLowerCase()),
        category: norm(resource.tags[0]),
        popularity: resource.viewCount
      });
    }
    return candidates;
  }

  /**
   * Per-member recommendations. Cold-start members get the popularity-based
   * trending fallback; everyone else gets signal-scored ranking adjusted by
   * global + own feedback.
   */
  async recommendFor(
    userId: string,
    options: { limit?: number; weights?: RecommenderWeights; now?: Date } = {}
  ): Promise<ScoredRecommendation[]> {
    const limit = options.limit ?? 10;
    const [signals, candidates, globalEvents, memberEvents] = await Promise.all([
      this.signalsFor(userId),
      this.collectCandidates(),
      this.feedback.all(),
      this.feedback.find({ userId })
    ]);
    const globalAggregates = aggregateFeedback(globalEvents);
    const memberActions = ownActions(memberEvents);

    const ranked = isColdStart(signals)
      ? coldStartRank(candidates, limit)
      : rankCandidates(signals, candidates, { limit: limit * 3, weights: options.weights });

    // Feedback adjustment, then re-rank to the requested limit.
    return ranked
      .map((item) => ({
        ...item,
        score: adjustScore(
          item.score,
          globalAggregates.get(`${item.type}:${item.id}`) ?? { clicks: 0, dismissals: 0 },
          memberActions.get(`${item.type}:${item.id}`)
        )
      }))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  /** Item-to-item "similar content" across the four recommendation domains. */
  async similar(
    type: RecommendationType,
    id: string,
    limit = 10
  ): Promise<ScoredRecommendation[]> {
    const candidates = await this.collectCandidates();
    const source = candidates.find((candidate) => candidate.type === type && candidate.id === id);
    if (!source) {
      throw new NotFoundException(`No recommendable ${type} with id '${id}'`);
    }
    return similarItems(source, candidates, { limit });
  }

  /** Persists a clicked/dismissed event; future rankings pick it up. */
  async recordFeedback(
    userId: string,
    itemType: RecommendationType,
    itemId: string,
    action: FeedbackAction
  ): Promise<{ recorded: true; action: FeedbackAction }> {
    await this.feedback.create({
      id: newId('recfb'),
      userId,
      itemType,
      itemId,
      action,
      createdAt: new Date().toISOString()
    });
    return { recorded: true, action };
  }
}
