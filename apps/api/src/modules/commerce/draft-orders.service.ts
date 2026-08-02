import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { DraftOrder, Order, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  DRAFT_ORDER_REPOSITORY,
  LISTING_REPOSITORY,
  LISTING_VARIANT_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  DraftOrderRepository,
  ListingVariantRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { assertBuyerGroupManager } from './buyer-groups.service.js';
import { CheckoutService } from './checkout.service.js';
import { PricingService } from './pricing.service.js';

export interface CreateDraftOrderInput {
  listingId: string;
  variantId?: string;
  buyerId: string;
  quantity: number;
}

/**
 * Feature 7 (Wave M): draft orders. An admin or agent (chapter lead /
 * partner — the platform's agent-equivalent roles) drafts an order on
 * behalf of a buyer; the buyer confirms it into a normal order through a
 * guarded transition, or it is discarded.
 */
@Injectable()
export class DraftOrdersService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(DRAFT_ORDER_REPOSITORY) private readonly drafts: DraftOrderRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(LISTING_VARIANT_REPOSITORY) private readonly variants: ListingVariantRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly pricing: PricingService,
    private readonly checkout: CheckoutService
  ) {}

  async listDrafts(filter: { buyerId?: string; sellerId?: string; status?: DraftOrder['status'] }): Promise<DraftOrder[]> {
    return this.drafts.find(filter);
  }

  async getDraft(id: string): Promise<DraftOrder> {
    return this.drafts.getById(id);
  }

  async createDraft(input: CreateDraftOrderInput, actor: Pick<User, 'id' | 'roles'>): Promise<DraftOrder> {
    assertBuyerGroupManager(actor);
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
    let unitPriceKobo = listing.priceNaira * 100;
    if (input.variantId) {
      const variant = await this.variants.getById(input.variantId);
      if (variant.listingId !== input.listingId) {
        throw new BadRequestException(`Variant '${input.variantId}' does not belong to listing '${input.listingId}'`);
      }
      unitPriceKobo = (await this.pricing.resolvePrice(variant.id, input.buyerId)).priceKobo;
    }
    const now = new Date().toISOString();
    const draft: DraftOrder = {
      id: newId('draft'),
      listingId: input.listingId,
      variantId: input.variantId,
      buyerId: input.buyerId,
      sellerId: listing.sellerId,
      quantity: input.quantity,
      unitPriceKobo,
      status: 'open',
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.drafts.create(draft);
    await this.events.publish('marketplace.draft_order.created', { draftId: created.id }, actor.id);
    return created;
  }

  /**
   * Buyer confirmation: places the real order through checkout (channel
   * 'agent') and moves the draft to 'confirmed' with a guarded
   * compare-and-set so a double-confirm cannot place two orders.
   */
  async confirmDraft(id: string, actor: Pick<User, 'id' | 'roles'>): Promise<{ draft: DraftOrder; order: Order }> {
    const draft = await this.drafts.getById(id);
    if (draft.status === 'confirmed') {
      // Idempotent replay: return the already-placed order.
      if (!draft.orderId) {
        throw new BadRequestException(`Draft order ${id} has no confirmed order`);
      }
      return { draft, order: await this.orders.getById(draft.orderId) };
    }
    if (draft.status !== 'open') {
      throw new BadRequestException(`Draft order ${id} is '${draft.status}' and cannot be confirmed`);
    }
    if (actor.id !== draft.buyerId && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the draft buyer or an administrator may confirm a draft order');
    }
    const { order } = await this.checkout.placeOrder(
      {
        listingId: draft.listingId,
        variantId: draft.variantId,
        buyerId: draft.buyerId,
        quantity: draft.quantity,
        channel: 'agent',
        draftId: draft.id,
        createdBy: draft.createdBy
      },
      actor
    );
    const confirmed = await this.drafts.updateExpected(
      id,
      { status: 'confirmed', orderId: order.id, updatedAt: new Date().toISOString() },
      { status: 'open' }
    );
    await this.events.publish(
      'marketplace.draft_order.confirmed',
      { draftId: id, orderId: order.id },
      actor.id
    );
    return { draft: confirmed, order };
  }

  async discardDraft(id: string, actor: Pick<User, 'id' | 'roles'>): Promise<DraftOrder> {
    const draft = await this.drafts.getById(id);
    if (draft.status === 'discarded') {
      return draft; // idempotent replay
    }
    if (draft.status !== 'open') {
      throw new BadRequestException(`Draft order ${id} is '${draft.status}' and cannot be discarded`);
    }
    const allowed = actor.id === draft.buyerId || actor.id === draft.createdBy || actor.roles.includes('admin');
    if (!allowed) {
      throw new ForbiddenException('Only the draft buyer, its creator, or an administrator may discard it');
    }
    const discarded = await this.drafts.updateExpected(
      id,
      { status: 'discarded', updatedAt: new Date().toISOString() },
      { status: 'open' }
    );
    await this.events.publish('marketplace.draft_order.discarded', { draftId: id }, actor.id);
    return discarded;
  }
}
