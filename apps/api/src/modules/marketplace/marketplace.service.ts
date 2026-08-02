import { BadRequestException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import type {
  ApiListResponse,
  LocationRef,
  MarketplaceListing,
  Order,
  OrderStatus,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { AuditService } from '../../core/audit.service.js';
import {
  LISTING_REPOSITORY,
  ORDER_REPOSITORY,
  REVIEW_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ListingCriteria,
  ListingRepository
} from '../../database/repositories/listing.repository.js';
import type { OrderCriteria, OrderRepository } from '../../database/repositories/order.repository.js';
import type { ReviewRepository } from '../../database/repositories/review.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import type { OrderReview } from '../../database/seed-data.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';

/** Orders at or above this value stay escrow-ready for settlement. */
const ESCROW_THRESHOLD_NAIRA = 100_000;

/** Which order party may drive each transition (admins may drive any of them). */
type OrderActor = 'buyer' | 'seller';

/**
 * Marketplace order state machine over ORDER_STATUSES
 * (docs/security-compliance.md §2: invalid transitions must be rejected
 * under retry). Terminal states (completed, cancelled) accept no outbound
 * transitions; re-sending the current status is an idempotent no-op.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, Readonly<Partial<Record<OrderStatus, readonly OrderActor[]>>>>> = {
  requested: {
    negotiating: ['seller'],
    confirmed: ['seller'],
    cancelled: ['buyer', 'seller']
  },
  negotiating: {
    confirmed: ['buyer', 'seller'],
    cancelled: ['buyer', 'seller']
  },
  confirmed: {
    deposit_paid: ['buyer'],
    cancelled: ['buyer', 'seller']
  },
  deposit_paid: {
    in_fulfilment: ['seller'],
    disputed: ['buyer', 'seller']
  },
  in_fulfilment: {
    delivered: ['seller'],
    disputed: ['buyer', 'seller']
  },
  delivered: {
    completed: ['buyer'],
    disputed: ['buyer', 'seller']
  },
  disputed: {
    // Disputes resolve through admin mediation only (empty actor list).
    completed: [],
    cancelled: []
  },
  completed: {},
  cancelled: {}
};

export interface CreateListingInput {
  sellerId: string;
  kind: MarketplaceListing['kind'];
  title: string;
  crop?: string;
  quantity: number;
  unit: string;
  priceNaira: number;
  location: LocationRef;
  harvestDate?: string;
}

export interface UpdateListingInput {
  title?: string;
  quantity?: number;
  priceNaira?: number;
  isActive?: boolean;
}

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(REVIEW_REPOSITORY) private readonly reviews: ReviewRepository,
    // Wave P2a commerce hooks (optional so bare service constructions in
    // tests keep working; always wired in the Nest module).
    @Optional() private readonly escrow?: EscrowService,
    @Optional() private readonly invoices?: InvoiceService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly audit?: AuditService
  ) {}

  async listListings(
    filter: ListingCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<MarketplaceListing>> {
    return this.listings.searchPage(
      {
        kind: filter.kind,
        state: filter.state,
        crop: filter.crop,
        active: filter.active,
        q: filter.q
      },
      filter.page,
      filter.pageSize
    );
  }

  async allListings(): Promise<MarketplaceListing[]> {
    return this.listings.all();
  }

  async getListing(id: string): Promise<MarketplaceListing> {
    return this.listings.getById(id);
  }

  async createListing(input: CreateListingInput): Promise<MarketplaceListing> {
    const listing: MarketplaceListing = {
      id: newId('listing'),
      sellerId: input.sellerId,
      kind: input.kind,
      title: input.title,
      crop: input.crop,
      quantity: input.quantity,
      unit: input.unit,
      priceNaira: input.priceNaira,
      location: input.location,
      harvestDate: input.harvestDate,
      isActive: true
    };
    const created = await this.listings.create(listing);
    await this.events.publish('marketplace.listing.created', { listingId: created.id }, input.sellerId);
    return created;
  }

  async updateListing(
    id: string,
    patch: UpdateListingInput,
    actorId: string
  ): Promise<MarketplaceListing> {
    const updated = await this.listings.update(id, patch);
    await this.events.publish('marketplace.listing.updated', { listingId: id }, actorId);
    return updated;
  }

  async placeOrder(listingId: string, buyerId: string, quantity: number): Promise<Order> {
    const listing = await this.listings.getById(listingId);
    if (!listing.isActive) {
      throw new BadRequestException('Listing is not active');
    }
    if (quantity <= 0 || quantity > listing.quantity) {
      throw new BadRequestException(`Quantity must be between 1 and ${listing.quantity}`);
    }
    if (listing.sellerId === buyerId) {
      throw new BadRequestException('Sellers cannot order their own listing');
    }
    const totalNaira = listing.priceNaira * quantity;
    const order: Order = {
      id: newId('order'),
      listingId,
      buyerId,
      sellerId: listing.sellerId,
      quantity,
      totalNaira,
      status: 'requested',
      escrowRequired: totalNaira >= ESCROW_THRESHOLD_NAIRA,
      createdAt: new Date().toISOString()
    };
    const created = await this.orders.placeOrder(order);
    this.metrics?.orderCreated(created.escrowRequired);
    await this.events.publish(
      'marketplace.order.placed',
      { orderId: created.id, listingId, totalNaira, escrowRequired: created.escrowRequired },
      buyerId
    );
    return created;
  }

  async listOrders(filter: OrderCriteria): Promise<Order[]> {
    return this.orders.find({
      buyerId: filter.buyerId,
      sellerId: filter.sellerId,
      status: filter.status
    });
  }

  async getOrder(id: string): Promise<Order> {
    return this.orders.getById(id);
  }

  /**
   * Drives the order state machine. Re-sending the current status is an
   * idempotent replay (returns the order unchanged, no duplicate event);
   * anything else must be a valid transition from ORDER_TRANSITIONS and the
   * actor must be an entitled party (buyer/seller per the transition, or an
   * administrator).
   */
  async setOrderStatus(
    id: string,
    status: OrderStatus,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Order> {
    const order = await this.orders.getById(id);
    if (order.status === status) {
      return order; // idempotent replay of a retry
    }
    const allowed = ORDER_TRANSITIONS[order.status]?.[status];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid order transition '${order.status}' -> '${status}' for order ${id}`
      );
    }
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin) {
      const party: OrderActor | null =
        actor.id === order.buyerId ? 'buyer' : actor.id === order.sellerId ? 'seller' : null;
      if (!party || !allowed.includes(party)) {
        throw new ForbiddenException(
          `Only the order ${allowed.length > 0 ? allowed.join(' or ') : 'administrator'} may move an order from '${order.status}' to '${status}'`
        );
      }
    }
    const updated = await this.orders.update(id, { status });
    // Payment-status transitions are metered and audited (observability plan
    // §A.3/§A.6): deposit_paid = payment initiated, completed = confirmed.
    if (status === 'deposit_paid' || status === 'completed') {
      this.metrics?.paymentEvent(status === 'deposit_paid' ? 'initiated' : 'confirmed');
      await this.audit?.record({
        actorId: actor.id,
        action: `marketplace.order.payment_${status === 'deposit_paid' ? 'initiated' : 'confirmed'}`,
        entityType: 'order',
        entityId: id,
        metadata: { from: order.status, to: status }
      });
    }
    await this.events.publish(
      'marketplace.order.status_changed',
      { orderId: id, from: order.status, to: status },
      actor.id
    );
    // Wave P2a commerce hooks (all idempotent no-ops when nothing applies):
    // confirm → issue invoice; deposit → hold escrow; cancel → refund escrow
    // + cancel invoice; complete → release escrow + mark invoice paid.
    if (status === 'confirmed') {
      await this.invoices?.issueForOrder(id, actor.id);
    } else if (status === 'deposit_paid' && updated.escrowRequired) {
      await this.escrow?.holdForOrder(id, actor.id);
    } else if (status === 'disputed') {
      await this.escrow?.disputeForOrder(id, actor.id);
    } else if (status === 'cancelled') {
      await this.escrow?.refundForOrder(id, actor.id);
      await this.invoices?.cancelForOrder(id, actor.id);
    } else if (status === 'completed') {
      await this.escrow?.releaseForOrder(id, actor.id);
      await this.invoices?.markPaidForOrder(id, actor.id);
    }
    return updated;
  }

  async reviewOrder(
    orderId: string,
    authorId: string,
    rating: number,
    comment?: string
  ): Promise<OrderReview> {
    const order = await this.orders.getById(orderId);
    if (order.status !== 'delivered' && order.status !== 'completed') {
      throw new BadRequestException('Orders can only be reviewed after delivery');
    }
    const review: OrderReview = {
      id: newId('review'),
      orderId,
      authorId,
      rating,
      comment,
      createdAt: new Date().toISOString()
    };
    const created = await this.reviews.create(review);
    await this.events.publish('marketplace.review.submitted', { orderId, rating }, authorId);
    return created;
  }

  async reviewsForOrder(orderId: string): Promise<OrderReview[]> {
    return this.reviews.find({ orderId });
  }

  async activeListingCount(): Promise<number> {
    return this.listings.activeListingCount();
  }
}
