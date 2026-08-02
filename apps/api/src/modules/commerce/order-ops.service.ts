import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Order, OrderStatus, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  LISTING_REPOSITORY,
  LISTING_VARIANT_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  PROMOTION_REDEMPTION_REPOSITORY,
  PROMOTION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  ListingVariantRepository,
  OrderExtensionRepository,
  PromotionRedemptionRepository,
  PromotionRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { settleWholeNaira } from './checkout.service.js';

/** Orders in these pre-fulfilment statuses may still be edited. */
const EDITABLE_STATUSES: readonly OrderStatus[] = ['requested', 'negotiating', 'confirmed'];

/**
 * Feature 5 (Wave M): order edit & cancel-with-restock. Edits recalculate
 * totals atomically (guarded compare-and-set on the order row) and adjust
 * variant/listing stock by the delta; cancellations drive the existing
 * guarded order state machine (escrow refund + invoice cancel hooks) and
 * restock in the same flow.
 */
@Injectable()
export class OrderOpsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository,
    @Inject(ORDER_EXTENSION_REPOSITORY) private readonly extensions: OrderExtensionRepository,
    @Inject(PROMOTION_REPOSITORY) private readonly promotions: PromotionRepository,
    @Inject(PROMOTION_REDEMPTION_REPOSITORY) private readonly redemptions: PromotionRedemptionRepository,
    private readonly marketplace: MarketplaceService
  ) {}

  /**
   * Edits the order quantity before fulfilment. Stock is adjusted by the
   * delta (increment validated against available stock; decrement restocks)
   * and totals are recalculated from the recorded unit price with the
   * originally applied promotions re-evaluated against the new subtotal.
   */
  async editQuantity(
    orderId: string,
    newQuantity: number,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Order> {
    const order = await this.orders.getById(orderId);
    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Order ${orderId} can only be edited before fulfilment (current status '${order.status}')`
      );
    }
    if (actor.id !== order.buyerId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the buyer or an administrator may edit an order');
    }
    if (!Number.isSafeInteger(newQuantity) || newQuantity <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }
    const extension = await this.extensions.findById(orderId);
    const delta = newQuantity - order.quantity;
    if (delta === 0) {
      return order; // idempotent replay
    }
    // Stock adjustment first: an increase fails fast when stock ran out.
    if (extension?.variantId) {
      if (delta > 0) {
        await this.variants.decrementStock(extension.variantId, delta);
      } else {
        await this.variants.restock(extension.variantId, -delta);
      }
    } else if (delta > 0) {
      const listing = await this.listings.getById(order.listingId);
      if (delta > listing.quantity) {
        throw new BadRequestException(`Quantity must be between 1 and ${listing.quantity + order.quantity}`);
      }
      await this.listings.update(order.listingId, { quantity: listing.quantity - delta });
    } else {
      await this.listings.restock(order.listingId, -delta);
    }
    // Recalculate totals (kobo) from the recorded unit price.
    const unitPriceKobo = extension?.unitPriceKobo ?? order.totalNaira * 100 / order.quantity;
    const subtotalKobo = Math.round(unitPriceKobo) * newQuantity;
    let discountKobo = 0;
    for (const redemption of await this.redemptions.find({ orderId })) {
      const promotion = await this.promotions.findById(redemption.promotionId);
      if (!promotion) {
        continue;
      }
      const raw =
        promotion.kind === 'percentage'
          ? Math.floor((subtotalKobo * promotion.value) / 10_000)
          : promotion.value;
      const appliedDiscount = Math.min(raw, subtotalKobo - discountKobo);
      discountKobo += appliedDiscount;
      await this.redemptions.update(redemption.id, { discountKobo: appliedDiscount });
    }
    const [totalNaira, settledDiscountKobo] = settleWholeNaira(subtotalKobo - discountKobo, discountKobo);
    // Guarded write: a concurrent status/quantity change loses with a 409.
    const event = this.events.build(
      'marketplace.order.edited',
      { orderId, from: order.quantity, to: newQuantity, totalNaira },
      actor.id
    );
    const updated = await this.orders.updateExpected(
      orderId,
      { quantity: newQuantity, totalNaira },
      { status: order.status, quantity: order.quantity },
      event
    );
    if (this.orders.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    if (extension) {
      await this.extensions.update(orderId, {
        subtotalKobo,
        discountKobo: settledDiscountKobo,
        totalKobo: totalNaira * 100,
        updatedAt: new Date().toISOString()
      });
    }
    return updated;
  }

  /**
   * Cancels an order before completion and restocks the purchased variant
   * (or listing) atomically in the same flow. The cancellation itself goes
   * through the guarded order state machine, so escrow refunds and invoice
   * cancellations keep their funds-integrity guarantees.
   */
  async cancelWithRestock(orderId: string, actor: Pick<User, 'id' | 'roles'>): Promise<Order> {
    const order = await this.orders.getById(orderId);
    if (order.status === 'cancelled') {
      return order; // idempotent replay of a retry
    }
    const cancelled = await this.marketplace.setOrderStatus(orderId, 'cancelled', actor);
    const extension = await this.extensions.findById(orderId);
    if (extension?.variantId) {
      await this.variants.restock(extension.variantId, order.quantity);
    } else {
      await this.listings.restock(order.listingId, order.quantity);
    }
    await this.events.publish(
      'marketplace.order.restocked',
      { orderId, variantId: extension?.variantId, quantity: order.quantity },
      actor.id
    );
    return cancelled;
  }
}
