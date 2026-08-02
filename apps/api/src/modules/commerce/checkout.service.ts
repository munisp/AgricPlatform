import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  AppliedPromotion,
  Order,
  OrderExtension,
  PromotionEvaluation,
  SalesChannel,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  LISTING_REPOSITORY,
  LISTING_VARIANT_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  AtomicVariantCheckoutRepository,
  ListingVariantRepository,
  OrderExtensionRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { PricingService } from './pricing.service.js';
import { PromotionsService } from './promotions.service.js';

/** Same escrow threshold as MarketplaceService (naira). */
const ESCROW_THRESHOLD_NAIRA = 100_000;

export interface CheckoutInput {
  listingId: string;
  variantId?: string;
  buyerId: string;
  quantity: number;
  promotionCode?: string;
  channel?: SalesChannel;
  /** Set when the order originates from a confirmed draft order. */
  draftId?: string;
  createdBy?: string;
}

export interface CheckoutResult {
  order: Order;
  extension: OrderExtension;
  evaluation: PromotionEvaluation;
}

/**
 * Settles an order total in whole naira so escrow math
 * (`totalNaira * 100`) is always an exact kobo integer: any sub-naira
 * remainder is absorbed into the recorded discount (never overcharges the
 * buyer). Returns [totalNaira, settledDiscountKobo].
 */
export function settleWholeNaira(totalKobo: number, discountKobo: number): [number, number] {
  const totalNaira = Math.ceil(totalKobo / 100);
  return [totalNaira, discountKobo + (totalNaira * 100 - totalKobo)];
}

/**
 * Wave M checkout (features 1, 2, 3, 8): order placement against a listing
 * variant with price-list resolution, promotion evaluation and a sales
 * channel. On pg the variant decrement, order insert and order-extension
 * insert commit in ONE transaction (G8 — no compensation window); in memory
 * the decrement is a synchronous check-and-set and a failed insert restocks.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository,
    @Inject(ORDER_EXTENSION_REPOSITORY) private readonly extensions: OrderExtensionRepository,
    private readonly pricing: PricingService,
    private readonly promotions: PromotionsService
  ) {}

  async preview(input: CheckoutInput): Promise<PromotionEvaluation & { unitPriceKobo: number }> {
    const { unitPriceKobo } = await this.unitPrice(input);
    return {
      unitPriceKobo,
      ...(await this.promotions.evaluate({
        subtotalKobo: unitPriceKobo * input.quantity,
        listingId: input.listingId,
        buyerId: input.buyerId,
        code: input.promotionCode
      }))
    };
  }

  async placeOrder(input: CheckoutInput, actor: Pick<User, 'id' | 'roles'>): Promise<CheckoutResult> {
    const listing = await this.listings.getById(input.listingId);
    if (!listing.isActive) {
      throw new BadRequestException('Listing is not active');
    }
    if (listing.sellerId === input.buyerId) {
      throw new BadRequestException('Sellers cannot order their own listing');
    }
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    const listingVariants = await this.variants.find({ listingId: input.listingId, active: true });
    if (listingVariants.length > 0 && !input.variantId) {
      throw new BadRequestException('This listing has variants; order placement must target a variant');
    }
    const { unitPriceKobo, variantId } = await this.unitPrice(input);
    const subtotalKobo = unitPriceKobo * input.quantity;
    const evaluation = await this.promotions.evaluate({
      subtotalKobo,
      listingId: input.listingId,
      buyerId: input.buyerId,
      code: input.promotionCode
    });
    if (input.promotionCode && evaluation.rejectedCode) {
      throw new BadRequestException(
        `Coupon '${evaluation.rejectedCode.code}' rejected: ${evaluation.rejectedCode.reason}`
      );
    }
    const [totalNaira, settledDiscountKobo] = settleWholeNaira(evaluation.totalKobo, evaluation.discountKobo);
    const order: Order = {
      id: newId('order'),
      listingId: input.listingId,
      buyerId: input.buyerId,
      sellerId: listing.sellerId,
      quantity: input.quantity,
      totalNaira,
      status: 'requested',
      escrowRequired: totalNaira >= ESCROW_THRESHOLD_NAIRA,
      createdAt: new Date().toISOString()
    };
    const now = new Date().toISOString();
    const extension: OrderExtension = {
      id: order.id,
      orderId: order.id,
      variantId,
      channel: input.channel ?? 'web',
      unitPriceKobo,
      subtotalKobo,
      discountKobo: settledDiscountKobo,
      totalKobo: totalNaira * 100,
      draftId: input.draftId,
      createdBy: input.createdBy ?? actor.id,
      createdAt: now,
      updatedAt: now
    };
    let created: Order;
    let extensionPersisted = false;
    const atomicVariants = this.variants as ListingVariantRepository &
      Partial<AtomicVariantCheckoutRepository>;
    if (variantId && typeof atomicVariants.placeVariantOrder === 'function') {
      // pg path (G8): conditional decrement + order insert + extension
      // insert commit in ONE transaction — all-or-nothing, no compensation
      // window that can leak stock on a mid-path crash.
      created = await atomicVariants.placeVariantOrder(order, extension);
      extensionPersisted = true;
    } else if (variantId) {
      // In-memory path: decrementStock is a synchronous check-and-set, so
      // the decrement→insert sequence cannot interleave; a failed insert
      // still restocks defensively.
      await this.variants.decrementStock(variantId, input.quantity);
      try {
        created = await this.orders.create(order);
      } catch (error) {
        await this.variants.restock(variantId, input.quantity);
        throw error;
      }
    } else {
      // Listing-level orders use the existing atomic decrement+insert path.
      created = await this.orders.placeOrder(order);
    }
    try {
      if (!extensionPersisted) {
        await this.extensions.create(extension);
      }
      await this.recordApplied(created.id, evaluation.applied);
    } catch (error) {
      // Compensation: release the stock held for this order and drop the
      // order (and extension, when it already committed) so a failed
      // checkout leaves no partial state.
      if (variantId) {
        await this.variants.restock(variantId, input.quantity);
      } else {
        await this.listings.restock(listing.id, input.quantity);
      }
      await this.orders.remove(created.id);
      if (extensionPersisted) {
        await this.extensions.remove(extension.id);
      }
      throw error;
    }
    await this.events.publish(
      'marketplace.order.placed',
      {
        orderId: created.id,
        listingId: input.listingId,
        variantId,
        channel: extension.channel,
        totalNaira,
        discountKobo: settledDiscountKobo,
        escrowRequired: created.escrowRequired
      },
      actor.id
    );
    return { order: created, extension, evaluation };
  }

  private async recordApplied(orderId: string, applied: readonly AppliedPromotion[]): Promise<void> {
    if (applied.length > 0) {
      await this.promotions.recordRedemptions(orderId, applied);
    }
  }

  private async unitPrice(input: CheckoutInput): Promise<{ unitPriceKobo: number; variantId?: string }> {
    if (input.variantId) {
      const variant = await this.variants.getById(input.variantId);
      if (variant.listingId !== input.listingId) {
        throw new BadRequestException(`Variant '${input.variantId}' does not belong to listing '${input.listingId}'`);
      }
      const resolved = await this.pricing.resolvePrice(variant.id, input.buyerId);
      return { unitPriceKobo: resolved.priceKobo, variantId: variant.id };
    }
    const listing = await this.listings.getById(input.listingId);
    return { unitPriceKobo: listing.priceNaira * 100 };
  }
}
