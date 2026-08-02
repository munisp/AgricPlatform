import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryProductReviewRepository,
  createInMemorySellerRatingRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { ProductReviewsService } from './product-reviews.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };

// Seed order 'order-buyer-cassava': listing-cassava-kaduna, buyer user-buyer,
// seller user-adamu, starts 'confirmed'.
function makeStack() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const ratings = createInMemorySellerRatingRepository();
  const reviews = createInMemoryProductReviewRepository();
  const service = new ProductReviewsService(events, reviews, ratings, orders);
  return { orders, ratings, reviews, service };
}

async function fulfill(stack: ReturnType<typeof makeStack>) {
  await stack.orders.updateExpected('order-buyer-cassava', { status: 'delivered' }, { status: 'confirmed' });
}

const INPUT = { orderId: 'order-buyer-cassava', buyerId: 'user-buyer', rating: 5, comment: 'Clean bags' };

describe('ProductReviewsService verified purchase', () => {
  it('accepts a review from the buyer of a fulfilled order', async () => {
    const stack = makeStack();
    await fulfill(stack);
    const review = await stack.service.createReview('listing-cassava-kaduna', INPUT, buyer);
    expect(review.rating).toBe(5);
    expect(await stack.service.reviewsForListing('listing-cassava-kaduna')).toHaveLength(1);
  });

  it('rejects reviews before fulfilment', async () => {
    const stack = makeStack();
    await expect(stack.service.createReview('listing-cassava-kaduna', INPUT, buyer)).rejects.toThrowError(
      /fulfilled/
    );
  });

  it('rejects reviews from non-buyers and for other listings', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await expect(
      stack.service.createReview('listing-cassava-kaduna', { ...INPUT, buyerId: 'user-hassan' }, buyer)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      stack.service.createReview('listing-maize-kano', INPUT, buyer)
    ).rejects.toThrowError(/does not contain listing/);
  });

  it('validates the 1..5 rating range', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await expect(
      stack.service.createReview('listing-cassava-kaduna', { ...INPUT, rating: 0 }, buyer)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      stack.service.createReview('listing-cassava-kaduna', { ...INPUT, rating: 6 }, buyer)
    ).rejects.toThrowError(BadRequestException);
  });

  it('enforces one review per buyer per order (idempotency)', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await stack.service.createReview('listing-cassava-kaduna', INPUT, buyer);
    await expect(stack.service.createReview('listing-cassava-kaduna', INPUT, buyer)).rejects.toThrowError(
      ConflictException
    );
    // The duplicate did not inflate the seller aggregate.
    expect((await stack.service.sellerRating('user-adamu')).reviewCount).toBe(1);
  });
});

describe('ProductReviewsService seller ratings', () => {
  it('materializes the seller aggregate with each review', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await stack.service.createReview('listing-cassava-kaduna', INPUT, buyer);
    // Second fulfilled order for the same seller.
    await stack.orders.create({
      id: 'order-2',
      listingId: 'listing-cassava-kaduna',
      buyerId: 'user-buyer',
      sellerId: 'user-adamu',
      quantity: 1,
      totalNaira: 1000,
      status: 'completed',
      escrowRequired: false,
      createdAt: '2026-08-01T00:00:00.000Z'
    });
    await stack.service.createReview(
      'listing-cassava-kaduna',
      { orderId: 'order-2', buyerId: 'user-buyer', rating: 3 },
      buyer
    );
    const rating = await stack.service.sellerRating('user-adamu');
    expect(rating.reviewCount).toBe(2);
    expect(rating.ratingSum).toBe(8);
    expect(rating.average).toBe(4);
  });

  it('returns a zero aggregate for sellers without reviews', async () => {
    const stack = makeStack();
    const rating = await stack.service.sellerRating('user-farmer-2');
    expect(rating.reviewCount).toBe(0);
    expect(rating.average).toBe(0);
  });

  it('exposes aggregate maps for listing search enrichment', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await stack.service.createReview('listing-cassava-kaduna', INPUT, buyer);
    const map = await stack.service.ratingsForSellers(['user-adamu', 'user-farmer-2']);
    expect(map.get('user-adamu')?.average).toBe(5);
    expect(map.has('user-farmer-2')).toBe(false);
  });
});
