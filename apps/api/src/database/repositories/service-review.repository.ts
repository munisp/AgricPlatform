import type { ServiceReview } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ServiceReviewCriteria {
  bookingId?: string;
  supplierId?: string;
  authorId?: string;
}

export type ServiceReviewRepository = AsyncRepository<ServiceReview, ServiceReviewCriteria>;

export function serviceReviewMatcher(
  criteria: ServiceReviewCriteria
): (review: ServiceReview) => boolean {
  return (review) =>
    (!criteria.bookingId || review.bookingId === criteria.bookingId) &&
    (!criteria.supplierId || review.supplierId === criteria.supplierId) &&
    (!criteria.authorId || review.authorId === criteria.authorId);
}

export class InMemoryServiceReviewRepository
  extends InMemoryRepository<ServiceReview, ServiceReviewCriteria>
  implements ServiceReviewRepository
{
  constructor(seed: readonly ServiceReview[] = []) {
    super(seed, serviceReviewMatcher);
  }
}

export function createInMemoryServiceReviewRepository(): InMemoryServiceReviewRepository {
  return new InMemoryServiceReviewRepository();
}
