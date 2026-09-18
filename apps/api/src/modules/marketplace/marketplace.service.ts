import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type {
  ApiListResponse,
  LocationRef,
  MarketplaceListing,
  Order,
  OrderStatus,
  PaymentProviderPort,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  assertSameIdempotencyPayload,
  hashIdempotencyPayload
} from '../../common/idempotency/payload-hash.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { AuditService } from '../../core/audit.service.js';
import {
  LISTING_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  REVIEW_REPOSITORY,
  SELLER_RATING_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ListingCriteria,
  ListingRepository
} from '../../database/repositories/listing.repository.js';
import type { OrderCriteria, OrderRepository } from '../../database/repositories/order.repository.js';
import type { ReviewRepository } from '../../database/repositories/review.repository.js';
import type {
  OrderExtensionRepository,
  SellerRatingRepository
} from '../../database/repositories/commerce-depth.repository.js';
import type { SalesChannel, SellerRating } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import type { OrderReview } from '../../database/seed-data.js';
import {
  SYNC_ENTITY_MARKETPLACE_LISTING
} from '../sync/sync-proof-entities.js';
import type { SyncVersioningService } from '../sync/sync-versioning.service.js';
import { EscrowService, PAYMENT_PROVIDER, type DepositEvidence } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';

/** Orders at or above this value stay escrow-ready for settlement. */
const ESCROW_THRESHOLD_NAIRA = 100_000;

/**
 * Stage 24 (audit A1-8): a listing price must be representable in whole
 * kobo — priceNaira * 100 a safe integer — otherwise any order total can
 * strand mid-deposit (status written, escrow hold throwing on the
 * fractional kobo) with a verified charge orphaned at the provider.
 */
export function assertKoboRepresentable(priceNaira: number): void {
  if (!Number.isSafeInteger(priceNaira * 100)) {
    throw new BadRequestException(
      `priceNaira ${priceNaira} is not representable in whole kobo; use at most two decimal places`
    );
  }
}

/**
 * V-36: seller-side release part of a partial-fulfilment settlement, in
 * integer kobo. Pro-rata on quantity, FLOOR-truncated so the release never
 * exceeds the delivered share; the buyer's refund part is the exact
 * remainder, so release + refund always sum to the held amount (no dust).
 */
export function partialReleaseKobo(
  amountKobo: number,
  deliveredQuantity: number,
  orderedQuantity: number
): number {
  return Math.floor((amountKobo * deliveredQuantity) / orderedQuantity);
}

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
    disputed: ['buyer', 'seller'],
    // V-50: compensating cancel of a paid order whose offtake delivery saga
    // failed AFTER the deposit — admin/system-mediated only (empty actor
    // list, same doctrine as dispute resolution). The cancel hook refunds
    // the held escrow (ESCROW_TRANSITIONS refund path) and cancels the
    // invoice, so no paid order is ever orphaned by a failed saga.
    cancelled: []
  },
  in_fulfilment: {
    delivered: ['seller'],
    disputed: ['buyer', 'seller'],
    // V-36: terminal shipment failure fast-tracks the unwind (escrow refund
    // + invoice cancel) instead of waiting out the escrow expiry — admin/
    // system mediated only (empty actor list, dispute-resolution doctrine).
    cancelled: []
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
  /** Optional link to the certified livestock listing (G18; migration 019a). */
  certifiedListingId?: string;
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
    @Optional() private readonly audit?: AuditService,
    // Wave M: materialized seller ratings enrich listing search responses
    // (optional so bare service constructions in tests keep working).
    @Optional() @Inject(SELLER_RATING_REPOSITORY) private readonly sellerRatings?: SellerRatingRepository,
    // Wave M order_extensions side table powers the /orders?channel= filter
    // (G19; optional so bare service constructions in tests keep working).
    @Optional() @Inject(ORDER_EXTENSION_REPOSITORY) private readonly extensions?: OrderExtensionRepository,
    // Wave SYNCSRV: sync version bumps on listing writes (optional so bare
    // service constructions in tests keep working; additive + non-fatal).
    @Optional() private readonly syncVersioning?: SyncVersioningService,
    // Stage 22 (audit C2): payment provider for verify-before-credit on the
    // deposit_paid transition. Optional so bare service constructions in
    // tests keep working; registered from MarketplaceModule.
    @Optional() @Inject(PAYMENT_PROVIDER) private readonly payments?: PaymentProviderPort
  ) {}

  async listListings(
    filter: ListingCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<MarketplaceListing & { sellerRating?: SellerRating }>> {
    const page = await this.listings.searchPage(
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
    if (!this.sellerRatings) {
      return page;
    }
    // Wave M: expose the materialized seller rating in search responses.
    const ratings = new Map<string, SellerRating>();
    for (const sellerId of new Set(page.data.map((listing) => listing.sellerId))) {
      const rating = await this.sellerRatings.findById(sellerId);
      if (rating) {
        ratings.set(sellerId, rating);
      }
    }
    return {
      ...page,
      data: page.data.map((listing) => ({ ...listing, sellerRating: ratings.get(listing.sellerId) }))
    };
  }

  async allListings(): Promise<MarketplaceListing[]> {
    return this.listings.all();
  }

  async getListing(id: string): Promise<MarketplaceListing> {
    return this.listings.getById(id);
  }

  async createListing(input: CreateListingInput): Promise<MarketplaceListing> {
    assertKoboRepresentable(input.priceNaira);
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
      certifiedListingId: input.certifiedListingId,
      isActive: true
    };
    const created = await this.listings.create(listing);
    await this.events.publish('marketplace.listing.created', { listingId: created.id }, input.sellerId);
    await this.syncVersioning?.recordChange({
      entity: SYNC_ENTITY_MARKETPLACE_LISTING,
      entityId: created.id,
      ownerId: created.sellerId,
      actorId: input.sellerId
    });
    return created;
  }

  async updateListing(
    id: string,
    patch: UpdateListingInput,
    actorId: string
  ): Promise<MarketplaceListing> {
    if (patch.priceNaira !== undefined) {
      assertKoboRepresentable(patch.priceNaira);
    }
    const updated = await this.listings.update(id, patch);
    await this.events.publish('marketplace.listing.updated', { listingId: id }, actorId);
    await this.syncVersioning?.recordChange({
      entity: SYNC_ENTITY_MARKETPLACE_LISTING,
      entityId: id,
      ownerId: updated.sellerId,
      actorId
    });
    return updated;
  }

  /**
   * Places an order with atomic stock decrement (the repository locks /
   * CASes the listing). Idempotency (Stage 27 WP-G11, V2 audit): callers
   * may pass a client idempotency key — a transport retry with the same
   * key and the same (listing, buyer, quantity) payload replays the
   * original order instead of double-booking stock, and the same key with
   * a DIFFERENT payload fails closed with 409 IDEMPOTENCY_PAYLOAD_MISMATCH
   * (previously a silent replay through the response cache, or a duplicate
   * order at the service layer). Concurrent twins converge on ONE order:
   * the loser's insert loses the idempotency_key UNIQUE race and adopts
   * the winner's row (its stock decrement rolls back with the transaction).
   */
  async placeOrder(
    listingId: string,
    buyerId: string,
    quantity: number,
    idempotencyKey?: string
  ): Promise<Order> {
    // Replay check BEFORE validation: a legit retry must return the original
    // order even if the listing has since gone inactive or sold out.
    const payloadHash = idempotencyKey?.trim()
      ? hashIdempotencyPayload({ listingId, buyerId, quantity })
      : undefined;
    if (idempotencyKey?.trim()) {
      const replay = await this.orders.findOne({ idempotencyKey });
      if (replay) {
        assertSameIdempotencyPayload(idempotencyKey, replay.payloadHash, payloadHash ?? '');
        return replay;
      }
    }
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
      idempotencyKey: idempotencyKey?.trim() || undefined,
      payloadHash,
      createdAt: new Date().toISOString()
    };
    let created: Order;
    try {
      created = await this.orders.placeOrder(order);
    } catch (error) {
      if (
        order.idempotencyKey &&
        (error instanceof ConflictException || error instanceof BadRequestException)
      ) {
        // Twin adoption (WP-G11): a concurrent twin with the same client
        // key committed first — the loser can surface EITHER the
        // idempotency_key UNIQUE conflict (23505, pg insert; in-memory
        // create) or the stock CAS rejection (it read the pre-twin
        // quantity). When a row under the key exists, the operation
        // already happened: replay it when the payload matches, 409
        // IDEMPOTENCY_PAYLOAD_MISMATCH when it does not. The pg placement
        // transaction rolled back (and the in-memory repository
        // compensates), so the loser's stock decrement never persisted.
        // Without a twin row the original error stands (genuine stock
        // shortage or a vanished row).
        const twin = await this.orders.findOne({ idempotencyKey: order.idempotencyKey });
        if (twin) {
          assertSameIdempotencyPayload(order.idempotencyKey, twin.payloadHash, payloadHash ?? '');
          return twin;
        }
      }
      throw error;
    }
    this.metrics?.orderCreated(created.escrowRequired);
    await this.events.publish(
      'marketplace.order.placed',
      { orderId: created.id, listingId, totalNaira, escrowRequired: created.escrowRequired },
      buyerId
    );
    return created;
  }

  async listOrders(filter: OrderCriteria & { channel?: SalesChannel }): Promise<Order[]> {
    const orders = await this.orders.find({
      buyerId: filter.buyerId,
      sellerId: filter.sellerId,
      status: filter.status
    });
    if (!filter.channel) {
      return orders;
    }
    // G19: channel lives on the Wave M order_extensions side table, so the
    // filter intersects the party-scoped orders with extension rows.
    if (!this.extensions) {
      return [];
    }
    const channelOrderIds = new Set(
      (await this.extensions.find({ channel: filter.channel })).map((row) => row.orderId)
    );
    return orders.filter((order) => channelOrderIds.has(order.id));
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
   *
   * Stage 22 (audit C2, verify-before-credit): the deposit_paid transition
   * requires a paymentReference, verified with the configured payment
   * provider (status success AND exact kobo amount) before the status
   * changes and escrow is held; completing an escrow-backed order requires
   * the escrow's deposit to have reached deposit_paid through that verified
   * path.
   */
  async setOrderStatus(
    id: string,
    status: OrderStatus,
    actor: Pick<User, 'id' | 'roles'>,
    options?: { paymentReference?: string }
  ): Promise<Order> {
    const order = await this.orders.getById(id);
    if (order.status === status) {
      // Stage 24 (audit A1-8): a prior deposit_paid attempt may have crashed
      // between the status write and the escrow hold. Re-drive the idempotent
      // hold on replay (with freshly re-verified evidence when verification
      // is required) so a paid order is never stranded without its escrow.
      if (status === 'deposit_paid' && order.escrowRequired && this.escrow) {
        const existing = await this.escrow.escrowForOrder(id);
        if (!existing) {
          const deposit = await this.verifyDeposit(order, options?.paymentReference, actor.id);
          await this.escrow.holdForOrder(id, actor.id, deposit);
        }
      }
      // V-53: a prior confirm attempt may have crashed between the guarded
      // status write and the invoice hook. Re-drive the idempotent
      // issueForOrder on replay so a confirmed order is never stranded
      // without its invoice.
      if (status === 'confirmed' && this.invoices) {
        await this.invoices.issueForOrder(id, actor.id);
      }
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
    // Verify-before-credit gates run BEFORE the guarded status write so a
    // rejected deposit/completion leaves the order in its prior state and
    // the transition can simply be retried with valid evidence.
    let deposit: DepositEvidence | undefined;
    if (status === 'deposit_paid') {
      deposit = await this.verifyDeposit(order, options?.paymentReference, actor.id);
    } else if (status === 'completed') {
      await this.assertVerifiedEscrowForCompletion(order);
    }
    // Guarded write (funds-integrity wave): a concurrent transition that
    // already moved the order fails with a 409 instead of silently
    // overwriting; on PostgreSQL the outbox event commits with the update.
    const event = this.events.build(
      'marketplace.order.status_changed',
      { orderId: id, from: order.status, to: status },
      actor.id
    );
    const updated = await this.orders.updateExpected(id, { status }, { status: order.status }, event);
    if (this.orders.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
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
    // Wave P2a commerce hooks (all idempotent no-ops when nothing applies):
    // confirm → issue invoice; deposit → hold escrow; cancel → refund escrow
    // + cancel invoice; complete → release escrow + mark invoice paid.
    if (status === 'confirmed') {
      await this.invoices?.issueForOrder(id, actor.id);
    } else if (status === 'deposit_paid' && updated.escrowRequired) {
      await this.escrow?.holdForOrder(id, actor.id, deposit);
    } else if (status === 'disputed') {
      await this.escrow?.disputeForOrder(id, actor.id);
    } else if (status === 'cancelled') {
      await this.escrow?.refundForOrder(id, actor.id);
      await this.invoices?.cancelForOrder(id, actor.id);
    } else if (status === 'completed') {
      // V-36: a partially-delivered order settles its escrow by SPLIT — the
      // delivered share releases to the seller, the remainder refunds to the
      // buyer — instead of an all-or-nothing release.
      const partiallyDelivered =
        updated.deliveredQuantity !== undefined && updated.deliveredQuantity < updated.quantity;
      if (partiallyDelivered && this.escrow) {
        const record = await this.escrow.escrowForOrder(id);
        if (record) {
          const releaseKobo = partialReleaseKobo(record.amountKobo, updated.deliveredQuantity!, updated.quantity);
          await this.escrow.settlePartialForOrder(id, releaseKobo, actor.id);
        }
      } else {
        await this.escrow?.releaseForOrder(id, actor.id);
      }
      await this.invoices?.markPaidForOrder(id, actor.id);
    }
    return updated;
  }

  /**
   * V-06: admin dispute resolution with a SPLIT award. `releaseKobo` is the
   * seller's part, the remainder refunds to the buyer; the escrow validates
   * that the parts sum exactly to the held amount. The order then completes
   * (buyer accepted goods worth the released part) or cancels (full refund),
   * through the same guarded order machine as any other resolution.
   * Idempotent: replaying the same award returns the already-resolved order.
   */
  async resolveDispute(
    orderId: string,
    award: { releaseKobo: number },
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Order> {
    if (!actor.roles.includes('admin')) {
      throw new ForbiddenException('Only an administrator may resolve a disputed order');
    }
    const order = await this.orders.getById(orderId);
    if (order.status === 'completed' || order.status === 'cancelled') {
      return order; // idempotent replay of a resolved dispute
    }
    if (order.status !== 'disputed') {
      throw new BadRequestException(
        `Order ${orderId} is '${order.status}'; only a disputed order can be resolved by award`
      );
    }
    if (order.escrowRequired && this.escrow) {
      const record = await this.escrow.escrowForOrder(orderId);
      if (!record) {
        throw new ConflictException(
          `Order ${orderId} requires escrow but none exists; resolve the escrow state first`
        );
      }
      await this.escrow.resolveDisputeSplit(
        record.id,
        { releaseKobo: award.releaseKobo, refundKobo: record.amountKobo - award.releaseKobo },
        actor
      );
    }
    return this.setOrderStatus(orderId, award.releaseKobo > 0 ? 'completed' : 'cancelled', actor);
  }

  /**
   * V-36 partial fulfilment: the seller records that only `deliveredQuantity`
   * of the ordered quantity was delivered. The order moves to 'delivered'
   * carrying the partial quantity; when the buyer (or an admin) completes the
   * order, the escrow settles by split (see the completed hook above).
   * CAS-guarded from 'in_fulfilment'; a replay with the same quantity is an
   * idempotent no-op, a conflicting quantity on an already-recorded partial
   * delivery is a 409.
   */
  async recordPartialDelivery(
    id: string,
    deliveredQuantity: number,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Order> {
    const order = await this.orders.getById(id);
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin && actor.id !== order.sellerId) {
      throw new ForbiddenException('Only the order seller may record a partial delivery');
    }
    if (!Number.isSafeInteger(deliveredQuantity) || deliveredQuantity <= 0 || deliveredQuantity >= order.quantity) {
      throw new BadRequestException(
        `deliveredQuantity must be an integer between 1 and ${order.quantity - 1} for a partial delivery of order ${id}`
      );
    }
    if (order.deliveredQuantity !== undefined) {
      if (order.deliveredQuantity === deliveredQuantity) {
        return order; // idempotent replay
      }
      throw new ConflictException(
        `Order ${id} already recorded a partial delivery of ${order.deliveredQuantity}; refusing to change it`
      );
    }
    if (order.status !== 'in_fulfilment') {
      throw new BadRequestException(
        `Order ${id} is '${order.status}'; a partial delivery records only while 'in_fulfilment'`
      );
    }
    const event = this.events.build(
      'marketplace.order.status_changed',
      { orderId: id, from: order.status, to: 'delivered', deliveredQuantity },
      actor.id
    );
    const updated = await this.orders.updateExpected(
      id,
      { status: 'delivered', deliveredQuantity },
      { status: 'in_fulfilment' },
      event
    );
    if (this.orders.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'marketplace.order.partial_delivery',
      entityType: 'order',
      entityId: id,
      metadata: { deliveredQuantity, quantity: order.quantity }
    });
    return updated;
  }

  /**
   * Verify-before-credit (Stage 22, audit C2): the deposit_paid transition
   * is a money-crediting event, so a self-declared status flip is never
   * enough. The buyer must supply the payment reference; when a payment
   * provider is wired the reference is verified with the provider (status
   * success AND exact kobo amount vs the order total). Without a provider
   * the declarative path is a non-production convenience only — production
   * fails closed.
   */
  private async verifyDeposit(
    order: Order,
    paymentReference: string | undefined,
    actorId: string
  ): Promise<DepositEvidence> {
    const reference = paymentReference?.trim();
    if (!reference) {
      throw new BadRequestException(
        `A paymentReference is required to mark order ${order.id} deposit_paid; ` +
          'declarative payment claims are not accepted'
      );
    }
    // Stage 24 (audit A1-2): one verified charge credits exactly one order.
    // A reference already persisted on ANOTHER order's escrow record is a
    // pay-once/credit-N attempt — reject it before crediting again. The
    // same reference on THIS order's escrow is an idempotent replay. The
    // 049 partial UNIQUE index on deposit_payment_reference closes the
    // concurrent-first-use race (23505 → 409 on the escrow create).
    if (this.escrow) {
      const credited = await this.escrow.escrowForDepositReference(reference);
      if (credited && credited.orderId !== order.id) {
        throw new ConflictException(
          `Payment reference '${reference}' was already credited to order ${credited.orderId}; ` +
            `one verified charge can credit exactly one order (refusing order ${order.id})`
        );
      }
    }
    if (!this.payments) {
      if (isProduction()) {
        throw new ServiceUnavailableException(
          'No payment provider is configured (PAYMENT_DRIVER + provider credentials); ' +
            'deposit_paid cannot be verified, refusing the transition in production'
        );
      }
      return { reference, verified: false };
    }
    const verification = await this.payments.verify(reference);
    if (verification.status !== 'success') {
      throw new BadRequestException(
        `Payment provider '${this.payments.name}' reports status '${verification.status}' ` +
          `for reference '${reference}'; the deposit cannot be credited`
      );
    }
    const expectedKobo = Math.round(order.totalNaira * 100);
    if (verification.amountKobo !== expectedKobo) {
      throw new BadRequestException(
        `Verified amount ${verification.amountKobo} kobo does not match order ${order.id} ` +
          `total ${expectedKobo} kobo; the deposit cannot be credited`
      );
    }
    await this.audit?.record({
      actorId,
      action: 'marketplace.order.deposit_verified',
      entityType: 'order',
      entityId: order.id,
      metadata: {
        reference,
        provider: this.payments.name,
        amountKobo: verification.amountKobo,
        providerReference: verification.providerReference
      }
    });
    return { reference, verified: true };
  }

  /**
   * Stage 24 (audit A1-1): evidence for the direct POST /orders/:id/escrow
   * endpoint. When verification is required, the caller must supply the
   * payment reference so it can be re-verified with the provider (and
   * checked for cross-order reuse) before EscrowService will create the
   * hold; without a provider outside production the declarative hold is a
   * convenience and no evidence is needed (undefined).
   */
  async verifyDepositForHold(
    orderId: string,
    paymentReference: string | undefined,
    actorId: string
  ): Promise<DepositEvidence | undefined> {
    if (!this.payments && !isProduction()) {
      return undefined; // declarative holds are a non-production convenience
    }
    const order = await this.orders.getById(orderId);
    return this.verifyDeposit(order, paymentReference, actorId);
  }

  /**
   * Completion auto-release gate (Stage 22, audit C2): an escrow-backed
   * order may only complete (releasing escrow and marking the invoice paid)
   * when its deposit reached deposit_paid through the verified path. Runs
   * before the status write so a refused completion leaves the order
   * untouched; EscrowService.releaseForOrder enforces the same invariant
   * for its direct callers. Unverified holds (legacy rows, or holds created
   * without a provider while verification is required) need admin
   * mediation.
   */
  private async assertVerifiedEscrowForCompletion(order: Order): Promise<void> {
    if (!order.escrowRequired || !this.escrow) {
      return;
    }
    if (!this.payments && !isProduction()) {
      return; // declarative holds are a non-production convenience
    }
    const record = await this.escrow.escrowForOrder(order.id);
    // Stage 24 (audit A1-8): an escrow-required order with NO escrow record
    // at all (a stranded deposit_paid whose hold failed, or a legacy row)
    // must not complete — the verified charge would sit orphaned at the
    // provider with no escrow to settle it.
    if (!record) {
      throw new ConflictException(
        `Order ${order.id} cannot complete: it requires escrow but no escrow record exists. ` +
          'Re-drive the deposit_paid transition with the payment reference to create the hold.'
      );
    }
    if ((record.status === 'held' || record.status === 'releasing') && !record.depositVerifiedAt) {
      throw new ConflictException(
        `Order ${order.id} cannot complete: escrow ${record.id} has no provider-verified ` +
          'deposit. Resolve through the admin-mediated path.'
      );
    }
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
