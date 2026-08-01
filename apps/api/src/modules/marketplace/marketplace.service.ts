import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  ApiListResponse,
  LocationRef,
  MarketplaceListing,
  Order,
  OrderStatus,
  User
} from '@agric-platform/shared';
import { seedListings } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { seedOrders, type OrderReview } from '../../database/seed-data.js';

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
  private readonly listings = new InMemoryRepository<MarketplaceListing>(seedListings);
  private readonly orders = new InMemoryRepository<Order>(seedOrders);
  private readonly reviews = new InMemoryRepository<OrderReview>([]);

  constructor(private readonly events: DomainEventsService) {}

  listListings(filter: {
    kind?: MarketplaceListing['kind'];
    state?: string;
    crop?: string;
    q?: string;
    active?: boolean;
    page?: number;
    pageSize?: number;
  }): ApiListResponse<MarketplaceListing> {
    let items = this.listings.all();
    if (filter.kind) items = items.filter((l) => l.kind === filter.kind);
    if (filter.state) items = items.filter((l) => l.location.state === filter.state);
    if (filter.crop) items = items.filter((l) => l.crop === filter.crop);
    if (filter.active !== undefined) items = items.filter((l) => l.isActive === filter.active);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      items = items.filter((l) => l.title.toLowerCase().includes(q));
    }
    return paginate(items, filter.page, filter.pageSize);
  }

  allListings(): MarketplaceListing[] {
    return this.listings.all();
  }

  getListing(id: string): MarketplaceListing {
    return this.listings.getById(id);
  }

  createListing(input: CreateListingInput): MarketplaceListing {
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
    const created = this.listings.create(listing);
    this.events.publish('marketplace.listing.created', { listingId: created.id }, input.sellerId);
    return created;
  }

  updateListing(id: string, patch: UpdateListingInput, actorId: string): MarketplaceListing {
    const updated = this.listings.update(id, patch);
    this.events.publish('marketplace.listing.updated', { listingId: id }, actorId);
    return updated;
  }

  placeOrder(listingId: string, buyerId: string, quantity: number): Order {
    const listing = this.listings.getById(listingId);
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
    const created = this.orders.create(order);
    this.events.publish(
      'marketplace.order.placed',
      { orderId: created.id, listingId, totalNaira, escrowRequired: created.escrowRequired },
      buyerId
    );
    return created;
  }

  listOrders(filter: { buyerId?: string; sellerId?: string; status?: OrderStatus }): Order[] {
    return this.orders.find(
      (o) =>
        (!filter.buyerId || o.buyerId === filter.buyerId) &&
        (!filter.sellerId || o.sellerId === filter.sellerId) &&
        (!filter.status || o.status === filter.status)
    );
  }

  getOrder(id: string): Order {
    return this.orders.getById(id);
  }

  /**
   * Drives the order state machine. Re-sending the current status is an
   * idempotent replay (returns the order unchanged, no duplicate event);
   * anything else must be a valid transition from ORDER_TRANSITIONS and the
   * actor must be an entitled party (buyer/seller per the transition, or an
   * administrator).
   */
  setOrderStatus(id: string, status: OrderStatus, actor: Pick<User, 'id' | 'roles'>): Order {
    const order = this.orders.getById(id);
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
    const updated = this.orders.update(id, { status });
    this.events.publish(
      'marketplace.order.status_changed',
      { orderId: id, from: order.status, to: status },
      actor.id
    );
    return updated;
  }

  reviewOrder(orderId: string, authorId: string, rating: number, comment?: string): OrderReview {
    const order = this.orders.getById(orderId);
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
    const created = this.reviews.create(review);
    this.events.publish('marketplace.review.submitted', { orderId, rating }, authorId);
    return created;
  }

  reviewsForOrder(orderId: string): OrderReview[] {
    return this.reviews.find((r) => r.orderId === orderId);
  }

  activeListingCount(): number {
    return this.listings.count((l) => l.isActive);
  }
}
