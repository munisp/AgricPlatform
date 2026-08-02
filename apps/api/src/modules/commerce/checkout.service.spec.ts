import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
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
import { BuyerGroupsService } from './buyer-groups.service.js';
import { CheckoutService, settleWholeNaira } from './checkout.service.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const maizeSeller: Pick<User, 'id' | 'roles'> = { id: 'user-farmer-2', roles: ['farmer'] };

const VARIANT = {
  id: 'variant-maize-50kg',
  listingId: 'listing-maize-kano',
  sku: 'MAIZE-50KG-A',
  name: 'Grade A — 50kg',
  attributes: { grade: 'A' },
  priceKobo: 2_100_000,
  quantity: 3,
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
  const promotions = new PromotionsService(
    events,
    createInMemoryPromotionRepository(),
    createInMemoryPromotionRedemptionRepository(),
    buyerGroups
  );
  const checkout = new CheckoutService(events, listings, orders, variants, extensions, pricing, promotions);
  return { events, listings, orders, variants, extensions, buyerGroups, pricing, promotions, checkout };
}

describe('settleWholeNaira', () => {
  it('absorbs sub-naira remainders into the discount', () => {
    expect(settleWholeNaira(100_010, 0)).toEqual([1001, 90]);
    expect(settleWholeNaira(100_000, 5_000)).toEqual([1000, 5_000]);
    expect(settleWholeNaira(99_999, 1)).toEqual([1000, 2]);
  });
});

describe('CheckoutService variant orders', () => {
  it('places an order on a variant with atomic stock decrement', async () => {
    const { checkout, variants } = makeStack();
    const result = await checkout.placeOrder(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 2 },
      buyer
    );
    expect(result.order.totalNaira).toBe(42_000);
    expect(result.order.escrowRequired).toBe(false);
    expect((await variants.getById(VARIANT.id)).quantity).toBe(1);
    expect(result.extension.channel).toBe('web'); // default channel
    expect(result.extension.unitPriceKobo).toBe(2_100_000);
    expect(result.extension.totalKobo).toBe(4_200_000);
  });

  it('records the sales channel on the order extension', async () => {
    const { checkout, extensions } = makeStack();
    const { order } = await checkout.placeOrder(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1, channel: 'agent' },
      buyer
    );
    expect((await extensions.getById(order.id)).channel).toBe('agent');
  });

  it('requires a variant when the listing has active variants', async () => {
    const { checkout } = makeStack();
    await expect(
      checkout.placeOrder({ listingId: 'listing-maize-kano', buyerId: 'user-buyer', quantity: 1 }, buyer)
    ).rejects.toThrowError(/must target a variant/);
  });

  it('rejects variants from another listing and self-orders', async () => {
    const { checkout } = makeStack();
    await expect(
      checkout.placeOrder({ listingId: 'listing-cassava-kaduna', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1 }, buyer)
    ).rejects.toThrowError(/does not belong to listing/);
    await expect(
      checkout.placeOrder(
        { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-farmer-2', quantity: 1 },
        maizeSeller
      )
    ).rejects.toThrowError(/own listing/);
  });

  it('rejects oversell races: exactly one winner, stock never negative', async () => {
    const { checkout, variants } = makeStack();
    const results = await Promise.allSettled([
      checkout.placeOrder({ listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 3 }, buyer),
      checkout.placeOrder({ listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-hassan', quantity: 3 }, buyer)
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(BadRequestException);
    expect((await variants.getById(VARIANT.id)).quantity).toBe(0);
  });

  it('applies price lists before promotions at checkout', async () => {
    const { checkout, pricing, promotions } = makeStack();
    const list = await pricing.createPriceList({ name: 'Wholesale' }, { id: 'user-admin', roles: ['admin'] });
    await pricing.setEntry(list.id, VARIANT.id, 2_000_000, { id: 'user-admin', roles: ['admin'] });
    await promotions.createPromotion(
      { name: '10% off', kind: 'percentage', value: 1000 },
      { id: 'user-admin', roles: ['admin'] }
    );
    const result = await checkout.placeOrder(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1 },
      buyer
    );
    // 2_000_000 kobo - 10% = 1_800_000 kobo = 18_000 naira.
    expect(result.extension.unitPriceKobo).toBe(2_000_000);
    expect(result.extension.discountKobo).toBe(200_000);
    expect(result.order.totalNaira).toBe(18_000);
  });

  it('records applied promotions on the order and increments usage once', async () => {
    const { checkout, promotions } = makeStack();
    const promo = await promotions.createPromotion(
      { name: 'Coupon', kind: 'fixed', value: 100_000, code: 'SAVE1000' },
      { id: 'user-admin', roles: ['admin'] }
    );
    const result = await checkout.placeOrder(
      { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1, promotionCode: 'save1000' },
      buyer
    );
    const redemptions = await promotions.redemptionsForOrder(result.order.id);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0].discountKobo).toBe(100_000);
    expect((await promotions.getPromotion(promo.id)).usedCount).toBe(1);
  });

  it('rejects invalid coupon codes at checkout', async () => {
    const { checkout } = makeStack();
    await expect(
      checkout.placeOrder(
        { listingId: 'listing-maize-kano', variantId: VARIANT.id, buyerId: 'user-buyer', quantity: 1, promotionCode: 'NOPE' },
        buyer
      )
    ).rejects.toThrowError(/Unknown promotion code/);
  });

  it('escrow-flag: large discounted orders keep exact kobo totals', async () => {
    const { checkout } = makeStack([
      { ...VARIANT, id: 'variant-bulk', sku: 'BULK-1', priceKobo: 50_000_050, quantity: 10 }
    ]);
    const result = await checkout.placeOrder(
      { listingId: 'listing-maize-kano', variantId: 'variant-bulk', buyerId: 'user-buyer', quantity: 2 },
      buyer
    );
    // 2 × 50_000_050 = 100_000_100 kobo → settles at 1_000_001 naira (exact kobo).
    expect(Number.isSafeInteger(result.order.totalNaira * 100)).toBe(true);
    expect(result.order.totalNaira * 100).toBe(100_000_100);
    expect(result.order.escrowRequired).toBe(true);
    expect(result.extension.discountKobo).toBe(0);
  });

  it('previews a checkout without mutating stock', async () => {
    const { checkout, variants } = makeStack();
    const preview = await checkout.preview({
      listingId: 'listing-maize-kano',
      variantId: VARIANT.id,
      buyerId: 'user-buyer',
      quantity: 2
    });
    expect(preview.unitPriceKobo).toBe(2_100_000);
    expect(preview.subtotalKobo).toBe(4_200_000);
    expect((await variants.getById(VARIANT.id)).quantity).toBe(3);
  });
});

describe('CheckoutService listing-level orders (no variants)', () => {
  it('uses the existing atomic listing decrement path', async () => {
    const { checkout, listings } = makeStack([]);
    const result = await checkout.placeOrder(
      { listingId: 'listing-maize-kano', buyerId: 'user-buyer', quantity: 1 },
      buyer
    );
    expect((await listings.getById('listing-maize-kano')).quantity).toBe(1);
    expect(result.extension.variantId).toBeUndefined();
  });

  it('compensates stock when the extension write fails', async () => {
    const stack = makeStack([]);
    // Force extension creation to fail by pre-seeding a row with the same id
    // is not possible (fresh ids); instead break the repo.
    const failing = {
      ...stack.extensions,
      create: () => Promise.reject(new Error('simulated write failure')),
      findById: stack.extensions.findById.bind(stack.extensions)
    };
    const checkout = new CheckoutService(
      stack.events,
      stack.listings,
      stack.orders,
      stack.variants,
      failing as never,
      stack.pricing,
      stack.promotions
    );
    await expect(
      checkout.placeOrder({ listingId: 'listing-maize-kano', buyerId: 'user-buyer', quantity: 1 }, buyer)
    ).rejects.toThrowError(/simulated/);
    expect((await stack.listings.getById('listing-maize-kano')).quantity).toBe(2); // restocked
  });
});
