import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ProductReview, SellerRating, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ORDER_REPOSITORY,
  PRODUCT_REVIEW_REPOSITORY,
  SELLER_RATING_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  ProductReviewRepository,
  SellerRatingRepository
} from '../../database/repositories/commerce-depth.repository.js';

/**
 * Feature 9 (Wave M): verified-purchase product reviews + seller ratings.
 * Only the buyer of a fulfilled (delivered/completed) order containing the
 * listing may review it — enforced server-side — and each order yields at
 * most one review per buyer (UNIQUE constraint). The per-seller aggregate is
 * materialized transactionally with the review (atomic upsert on pg).
 */
@Injectable()
export class ProductReviewsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(PRODUCT_REVIEW_REPOSITORY) private readonly reviews: ProductReviewRepository,
    @Inject(SELLER_RATING_REPOSITORY) private readonly ratings: SellerRatingRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository
  ) {}

  async createReview(
    listingId: string,
    input: { orderId: string; buyerId: string; rating: number; comment?: string },
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<ProductReview> {
    if (actor.id !== input.buyerId && !actor.roles.includes('admin')) {
      throw new BadRequestException('Reviews must be authored by the purchasing buyer');
    }
    if (!Number.isSafeInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    const order = await this.orders.getById(input.orderId);
    if (order.listingId !== listingId) {
      throw new BadRequestException(`Order '${input.orderId}' does not contain listing '${listingId}'`);
    }
    if (order.buyerId !== input.buyerId) {
      throw new BadRequestException('Only the buyer of the order may review it');
    }
    if (order.status !== 'delivered' && order.status !== 'completed') {
      throw new BadRequestException('Only fulfilled (delivered/completed) orders can be reviewed');
    }
    const review: ProductReview = {
      id: newId('preview'),
      listingId,
      orderId: input.orderId,
      buyerId: input.buyerId,
      rating: input.rating,
      comment: input.comment,
      createdAt: new Date().toISOString()
    };
    const created = await this.reviews.create(review);
    await this.ratings.applyReview(order.sellerId, input.rating);
    await this.events.publish(
      'marketplace.product_review.submitted',
      { reviewId: created.id, listingId, orderId: input.orderId, rating: input.rating },
      actor.id
    );
    return created;
  }

  async reviewsForListing(listingId: string): Promise<ProductReview[]> {
    return this.reviews.find({ listingId });
  }

  async sellerRating(userId: string): Promise<SellerRating> {
    const existing = await this.ratings.findById(userId);
    if (existing) {
      return existing;
    }
    return { id: userId, userId, reviewCount: 0, ratingSum: 0, average: 0, updatedAt: new Date().toISOString() };
  }

  /** Aggregate map used to enrich listing search responses. */
  async ratingsForSellers(sellerIds: readonly string[]): Promise<Map<string, SellerRating>> {
    const map = new Map<string, SellerRating>();
    for (const sellerId of new Set(sellerIds)) {
      const rating = await this.ratings.findById(sellerId);
      if (rating) {
        map.set(sellerId, rating);
      }
    }
    return map;
  }
}
