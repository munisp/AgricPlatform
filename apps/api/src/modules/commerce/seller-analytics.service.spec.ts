import { describe, expect, it } from 'vitest';
import type { Order, OrderExtension, ReturnRequest } from '@agric-platform/shared';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import {
  createInMemoryListingVariantRepository,
  createInMemoryOrderExtensionRepository,
  createInMemoryReturnRequestRepository,
  createInMemorySellerRatingRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { SellerAnalyticsService } from './seller-analytics.service.js';

function order(id: string, status: Order['status'], totalNaira = 10_000): Order {
  return {
    id,
    listingId: 'listing-maize-kano',
    buyerId: 'user-buyer',
    sellerId: 'user-adamu',
    quantity: 2,
    totalNaira,
    status,
    escrowRequired: false,
    createdAt: '2026-08-01T00:00:00.000Z'
  };
}

function extension(orderId: string, variantId: string, totalKobo: number): OrderExtension {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    id: orderId,
    orderId,
    variantId,
    channel: 'web',
    unitPriceKobo: totalKobo / 2,
    subtotalKobo: totalKobo,
    discountKobo: 0,
    totalKobo,
    createdAt: now,
    updatedAt: now
  };
}

function makeStack() {
  const orders = new InMemoryOrderRepository([
    order('o1', 'completed', 20_000),
    order('o2', 'completed', 10_000),
    order('o3', 'delivered'),
    order('o4', 'cancelled'),
    order('o5', 'disputed'),
    order('o6', 'requested')
  ]);
  const extensions = createInMemoryOrderExtensionRepository([
    extension('o1', 'variant-a', 2_000_000),
    extension('o2', 'variant-a', 1_000_000)
  ]);
  const returns = createInMemoryReturnRequestRepository([
    {
      id: 'r1',
      orderId: 'o1',
      buyerId: 'user-buyer',
      reason: 'torn',
      status: 'requested',
      restock: false,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z'
    } satisfies ReturnRequest
  ]);
  const variants = createInMemoryListingVariantRepository([
    {
      id: 'variant-a',
      listingId: 'listing-maize-kano',
      sku: 'MAIZE-50KG-A',
      name: 'Grade A — 50kg',
      attributes: {},
      priceKobo: 1_000_000,
      quantity: 5,
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]);
  const ratings = createInMemorySellerRatingRepository();
  const service = new SellerAnalyticsService(orders, extensions, returns, variants, ratings);
  return { service, ratings };
}

describe('SellerAnalyticsService', () => {
  it('computes revenue from completed orders (exact kobo from extensions)', async () => {
    const { service } = makeStack();
    const analytics = await service.analyticsFor('user-adamu');
    expect(analytics.revenueKobo).toBe(3_000_000);
    expect(analytics.totalOrders).toBe(6);
  });

  it('breaks order counts down by status', async () => {
    const { service } = makeStack();
    const analytics = await service.analyticsFor('user-adamu');
    expect(analytics.orderCounts).toEqual({
      completed: 2,
      delivered: 1,
      cancelled: 1,
      disputed: 1,
      requested: 1
    });
  });

  it('computes fulfilment, dispute and return rates', async () => {
    const { service } = makeStack();
    const analytics = await service.analyticsFor('user-adamu');
    // 3 fulfilled of 5 non-cancelled.
    expect(analytics.fulfilmentRate).toBe(0.6);
    expect(analytics.disputeRate).toBe(0.167);
    // 1 of 3 fulfilled orders has a return.
    expect(analytics.returnRate).toBe(0.333);
  });

  it('ranks top variants by revenue', async () => {
    const { service } = makeStack();
    const analytics = await service.analyticsFor('user-adamu');
    expect(analytics.topVariants).toHaveLength(1);
    expect(analytics.topVariants[0]).toMatchObject({
      variantId: 'variant-a',
      sku: 'MAIZE-50KG-A',
      unitsSold: 4,
      revenueKobo: 3_000_000
    });
  });

  it('returns zeroed analytics for sellers without orders', async () => {
    const { service } = makeStack();
    const analytics = await service.analyticsFor('user-nobody');
    expect(analytics.totalOrders).toBe(0);
    expect(analytics.revenueKobo).toBe(0);
    expect(analytics.fulfilmentRate).toBe(0);
    expect(analytics.topVariants).toEqual([]);
  });

  it('attaches the materialized seller rating when present', async () => {
    const { service, ratings } = makeStack();
    await ratings.applyReview('user-adamu', 5);
    const analytics = await service.analyticsFor('user-adamu');
    expect(analytics.sellerRating?.average).toBe(5);
  });
});
