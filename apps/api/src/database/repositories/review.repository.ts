import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import type { OrderReview } from '../seed-data.js';

export interface ReviewCriteria {
  orderId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReviewRepository extends AsyncRepository<OrderReview, ReviewCriteria> {}

export function reviewMatcher(criteria: ReviewCriteria): (review: OrderReview) => boolean {
  return (review) => !criteria.orderId || review.orderId === criteria.orderId;
}

export class InMemoryReviewRepository
  extends InMemoryRepository<OrderReview, ReviewCriteria>
  implements ReviewRepository
{
  constructor(seed: readonly OrderReview[] = []) {
    super(seed, reviewMatcher);
  }
}

export function createInMemoryReviewRepository(): InMemoryReviewRepository {
  return new InMemoryReviewRepository([]);
}
