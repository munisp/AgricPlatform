import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/** Persisted recommendation feedback event (M16 Phase 3, Wave P5c). */
export interface RecommendationFeedbackEvent {
  id: string;
  userId: string;
  itemType: 'course' | 'opportunity' | 'listing' | 'knowledge';
  itemId: string;
  action: 'clicked' | 'dismissed';
  createdAt: string;
}

export interface RecommendationFeedbackCriteria {
  userId?: string;
  itemType?: RecommendationFeedbackEvent['itemType'];
  itemId?: string;
}

export type RecommendationFeedbackRepository = AsyncRepository<
  RecommendationFeedbackEvent,
  RecommendationFeedbackCriteria
>;

export function recommendationFeedbackMatcher(
  criteria: RecommendationFeedbackCriteria
): (event: RecommendationFeedbackEvent) => boolean {
  return (event) =>
    (!criteria.userId || event.userId === criteria.userId) &&
    (!criteria.itemType || event.itemType === criteria.itemType) &&
    (!criteria.itemId || event.itemId === criteria.itemId);
}

export class InMemoryRecommendationFeedbackRepository
  extends InMemoryRepository<RecommendationFeedbackEvent, RecommendationFeedbackCriteria>
  implements RecommendationFeedbackRepository
{
  constructor(seed: readonly RecommendationFeedbackEvent[] = []) {
    super(seed, recommendationFeedbackMatcher);
  }
}

export function createInMemoryRecommendationFeedbackRepository(
  seed: readonly RecommendationFeedbackEvent[] = []
): InMemoryRecommendationFeedbackRepository {
  return new InMemoryRecommendationFeedbackRepository(seed);
}
