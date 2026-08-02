import { Inject, Injectable } from '@nestjs/common';
import type { SellerAnalytics, TopVariantStat } from '@agric-platform/shared';
import {
  LISTING_VARIANT_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  RETURN_REQUEST_REPOSITORY,
  SELLER_RATING_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  ListingVariantRepository,
  OrderExtensionRepository,
  ReturnRequestRepository,
  SellerRatingRepository
} from '../../database/repositories/commerce-depth.repository.js';

const FULFILLED = new Set(['delivered', 'completed']);

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Feature 10 (Wave M): seller analytics. Computed from the order ledger
 * (marketplace orders + commerce order extensions) and the return queue:
 * revenue, order counts by status, fulfilment rate, dispute/return rates and
 * top variants by revenue. Party-scoped at the controller (sellers see
 * their own numbers; admins see all).
 */
@Injectable()
export class SellerAnalyticsService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ORDER_EXTENSION_REPOSITORY) private readonly extensions: OrderExtensionRepository,
    @Inject(RETURN_REQUEST_REPOSITORY) private readonly returns: ReturnRequestRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository,
    @Inject(SELLER_RATING_REPOSITORY) private readonly ratings: SellerRatingRepository
  ) {}

  async analyticsFor(sellerId: string): Promise<SellerAnalytics> {
    const orders = await this.orders.find({ sellerId });
    const orderCounts: Record<string, number> = {};
    for (const order of orders) {
      orderCounts[order.status] = (orderCounts[order.status] ?? 0) + 1;
    }
    const totalOrders = orders.length;
    const fulfilledOrders = orders.filter((order) => FULFILLED.has(order.status));
    const completedOrders = orders.filter((order) => order.status === 'completed');
    const cancelled = orderCounts['cancelled'] ?? 0;
    const disputed = orderCounts['disputed'] ?? 0;

    // Return rate: share of fulfilled orders with any return request.
    const returnedOrderIds = new Set<string>();
    for (const request of await this.returns.find({})) {
      returnedOrderIds.add(request.orderId);
    }
    const fulfilledWithReturn = fulfilledOrders.filter((order) => returnedOrderIds.has(order.id)).length;

    // Revenue: settled kobo totals of completed orders (order extensions
    // carry exact kobo; legacy orders fall back to totalNaira * 100).
    let revenueKobo = 0;
    const variantStats = new Map<string, { unitsSold: number; revenueKobo: number }>();
    for (const order of completedOrders) {
      const extension = await this.extensions.findById(order.id);
      const orderRevenue = extension ? extension.totalKobo : order.totalNaira * 100;
      revenueKobo += orderRevenue;
      if (extension?.variantId) {
        const stat = variantStats.get(extension.variantId) ?? { unitsSold: 0, revenueKobo: 0 };
        stat.unitsSold += order.quantity;
        stat.revenueKobo += orderRevenue;
        variantStats.set(extension.variantId, stat);
      }
    }
    const topVariants: TopVariantStat[] = [];
    for (const [variantId, stat] of variantStats) {
      const variant = await this.variants.findById(variantId);
      topVariants.push({
        variantId,
        sku: variant?.sku ?? variantId,
        name: variant?.name ?? variantId,
        unitsSold: stat.unitsSold,
        revenueKobo: stat.revenueKobo
      });
    }
    topVariants.sort((a, b) => b.revenueKobo - a.revenueKobo || b.unitsSold - a.unitsSold);

    return {
      sellerId,
      revenueKobo,
      orderCounts,
      totalOrders,
      fulfilmentRate: ratio(fulfilledOrders.length, totalOrders - cancelled),
      disputeRate: ratio(disputed, totalOrders),
      returnRate: ratio(fulfilledWithReturn, fulfilledOrders.length),
      topVariants: topVariants.slice(0, 5),
      sellerRating: await this.ratings.findById(sellerId)
    };
  }
}
