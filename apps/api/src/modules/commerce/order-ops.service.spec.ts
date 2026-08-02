import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import {
  createInMemoryBuyerGroupMembershipRepository,
  createInMemoryBuyerGroupRepository,
  createInMemoryListingVariantRepository,
  createInMemoryOrderExtensionRepository,
  createInMemoryPriceListEntryRepository,
  createInMemoryPriceListRepository,
  createInMemoryPromotionRedemptionRepository,
  createInMemoryPromotionRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { BuyerGroupsService } from './buyer-groups.service.js';
import { CheckoutService } from './checkout.service.js';
import { OrderOpsService } from './order-ops.service.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

const VARIANT = {
  id: 'variant-maize-50kg',
  listingId: 'listing-maize-kano',
  sku: 'MAIZE-50KG-A',
  name: 'Grade A — 50kg',
  attributes: {},
  priceKobo: 2_000_000,
  quantity: 10,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

function makeStack(variantSeed = [VARIANT]) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const variants = createInMemoryListingVariantRepository(variantSeed);
  const extensions = createInMemoryOrderExtensionRepository();
  const buyerGroups = new BuyerGroupsService(
    events,
    createInMemoryBuyerGroupRepository(),
    createInMemoryBuyerGroupMembershipRepository()
  );
  const pricing = new PricingService(
    events,
    createInMemoryPriceListRepository(),
    createInMemoryPriceListEntryRepository(),
    variants,
    buyerGroups
  );
  const redemptions = createInMemoryPromotionRedemptionRepository();
  const promotionRepo = createInMemoryPromotionRepository();
  const promotions = new PromotionsService(events, promotionRepo, redemptions, buyerGroups);
  const checkout = new CheckoutService(events, listings, orders, variants, extensions, pricing, promotions);
  const marketplace = new MarketplaceService(events, listings, orders, createInMemoryReviewRepository());
  const ops = new OrderOpsService(events, orders, listings, variants, extensions, promotionRepo, redemptions, marketplace);
  return { events, listings, orders, variants, extensions, promotions, checkout, marketplace, ops };
}

async function placedVariantOrder(stack: ReturnType<typeof makeStack>, quantity = 2) {
  const { order } = await stack.checkout.placeOrder(
    { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity },
    buyer
  );
  return order;
}

describe('OrderOpsService edit', () => {
  it('recalculates totals atomically when quantity increases', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 2); // 40_000 naira
    const updated = await stack.ops.editQuantity(order.id, 5, buyer);
    expect(updated.quantity).toBe(5);
    expect(updated.totalNaira).toBe(100_000);
    expect((await stack.variants.getById(VARIANT.id)).quantity).toBe(5);
    const extension = await stack.extensions.getById(order.id);
    expect(extension.subtotalKobo).toBe(10_000_000);
    expect(extension.totalKobo).toBe(10_000_000);
  });

  it('restocks the delta when quantity decreases', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 4);
    const updated = await stack.ops.editQuantity(order.id, 1, admin);
    expect(updated.totalNaira).toBe(20_000);
    expect((await stack.variants.getById(VARIANT.id)).quantity).toBe(9);
  });

  it('rejects increases beyond available stock', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 9);
    await expect(stack.ops.editQuantity(order.id, 12, buyer)).rejects.toThrowError(BadRequestException);
    expect((await stack.variants.getById(VARIANT.id)).quantity).toBe(1); // unchanged
    expect((await stack.orders.getById(order.id)).quantity).toBe(9);
  });

  it('rejects edits after fulfilment starts and by non-parties', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 2);
    await expect(stack.ops.editQuantity(order.id, 3, outsider)).rejects.toThrowError(ForbiddenException);
    await stack.marketplace.setOrderStatus(order.id, 'confirmed', { id: 'user-farmer-2', roles: ['farmer'] });
    await stack.marketplace.setOrderStatus(order.id, 'deposit_paid', buyer);
    await stack.marketplace.setOrderStatus(order.id, 'in_fulfilment', { id: 'user-farmer-2', roles: ['farmer'] });
    await expect(stack.ops.editQuantity(order.id, 3, buyer)).rejects.toThrowError(/before fulfilment/);
  });

  it('treats a same-quantity edit as an idempotent no-op', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 2);
    const replay = await stack.ops.editQuantity(order.id, 2, buyer);
    expect(replay.quantity).toBe(2);
    expect((await stack.events.listOutbox()).filter((e) => e.name === 'marketplace.order.edited')).toHaveLength(0);
  });

  it('re-evaluates recorded promotions against the new subtotal', async () => {
    const stack = makeStack();
    await stack.promotions.createPromotion({ name: 'Half', kind: 'percentage', value: 5000 }, admin);
    const order = await placedVariantOrder(stack, 2); // 40_000 → 20_000 after 50%
    expect(order.totalNaira).toBe(20_000);
    const updated = await stack.ops.editQuantity(order.id, 4, buyer);
    expect(updated.totalNaira).toBe(40_000); // 80_000 - 50%
    expect((await stack.extensions.getById(order.id)).discountKobo).toBe(4_000_000);
  });
});

describe('OrderOpsService cancel-with-restock', () => {
  it('cancels through the guarded state machine and restocks the variant', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 3);
    expect((await stack.variants.getById(VARIANT.id)).quantity).toBe(7);
    const cancelled = await stack.ops.cancelWithRestock(order.id, buyer);
    expect(cancelled.status).toBe('cancelled');
    expect((await stack.variants.getById(VARIANT.id)).quantity).toBe(10);
  });

  it('restocks listing-level orders too', async () => {
    const stack = makeStack([]);
    const { order } = await stack.checkout.placeOrder(
      { listingId: 'listing-maize-kano', buyerId: 'user-buyer', quantity: 1 },
      buyer
    );
    expect((await stack.listings.getById('listing-maize-kano')).quantity).toBe(1);
    await stack.ops.cancelWithRestock(order.id, buyer);
    expect((await stack.listings.getById('listing-maize-kano')).quantity).toBe(2);
  });

  it('is idempotent on replay and rejects non-party cancellation', async () => {
    const stack = makeStack();
    const order = await placedVariantOrder(stack, 2);
    await expect(stack.ops.cancelWithRestock(order.id, outsider)).rejects.toThrowError(ForbiddenException);
    await stack.ops.cancelWithRestock(order.id, buyer);
    const replay = await stack.ops.cancelWithRestock(order.id, buyer);
    expect(replay.status).toBe('cancelled');
    expect((await stack.variants.getById(VARIANT.id)).quantity).toBe(10); // restocked once
  });
});
